import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Each child substitutes the Discord client and HTTP transport before importing
// the real entrypoint. No test may open a Gateway or contact a provider.
const fixture = `
import { mock } from 'bun:test';
import { EventEmitter } from 'node:events';
const real = await import('discord.js');
const { Events } = real;
let ready = false, resolutions = 0, sends = 0;
const mode = process.env.SYNTHETIC_NOTICE_MODE;
class FakeClient extends EventEmitter {
  user = {id:'100000000000000006'};
  channels = {fetch:async(id)=>{
    if(!ready) throw new Error('channel resolution before readiness');
    resolutions++;
    return {id,type:0,guild:{id:'100000000000000001'},permissionsFor:()=>({has:()=>true})};
  }};
  isReady(){ return ready; }
  destroy(){ console.log(JSON.stringify({fixtureDone:true,resolutions,sends})); }
  async login(){
    setTimeout(async()=>{
      this.emit(Events.Raw,{op:0,t:'READY',s:1,d:{session_id:'synthetic-session'}},0);
      if(mode !== 'disabled') this.emit(Events.Raw,{op:0,t:'GUILD_MEMBER_REMOVE',s:2,d:{guild_id:'100000000000000001',user:{id:'100000000000000007'}}},0);
      await new Promise(r=>setTimeout(r,20));
      if(resolutions || sends) throw new Error('effect before readiness');
      if(mode === 'shutdown-before-ready' || mode === 'disabled') { process.emit('SIGTERM'); return; }
      ready=true; this.emit(Events.ClientReady);
      setTimeout(()=>process.emit('SIGTERM'),150);
    },0);
    return 'synthetic-session';
  }
}
mock.module('discord.js',()=>({...real,Client:FakeClient}));
if((await import('discord.js')).Client !== FakeClient) throw new Error('offline client substitution failed');
globalThis.fetch=async(input,init)=>{
  if(String(input)!=='https://discord-api.example.test/api/v10/channels/100000000000000003/messages') throw new Error('unapproved fixture network');
  const body=JSON.parse(String(init.body)); sends++;
  return new Response(JSON.stringify({id:'100000000000000005',channel_id:'100000000000000003',content:body.content,nonce:body.nonce,author:{id:'100000000000000006',bot:true}}),{headers:{'content-type':'application/json'}});
};
await import('./src/index.ts');
`;

describe("real entrypoint notice lifecycle with an offline client", () => {
  for (const mode of ["disabled", "shutdown-before-ready", "ready"] as const) {
    test(mode, async () => {
      const directory = await mkdtemp(join(tmpdir(), "reaper-lifecycle-"));
      try {
        const statePath = join(directory, "notices");
        const child = Bun.spawn([process.execPath, "--eval", fixture], {
          cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
          env: {
            SystemRoot: process.env.SystemRoot || "", NODE_ENV: "production",
            DISCORD_BOT_TOKEN: "synthetic-token", DISCORD_GUILD_ID: "100000000000000001",
            WELCOME_DM_ENABLED: "false", SYNTHETIC_NOTICE_MODE: mode,
            REAPER_MEMBER_NOTICES_ENABLED: mode === "disabled" ? "false" : "true",
            REAPER_MEMBER_NOTICE_CHANNEL_ID: "100000000000000003", REAPER_NOTICE_STATE_PATH: statePath,
            DISCORD_API_ORIGIN: "https://discord-api.example.test",
          },
        });
        const [status, output, errors] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        expect({status,errors}).toEqual({status:0,errors:""});
        const final = output.trim().split(/\r?\n/u).map(line => {
          try { return JSON.parse(line); } catch { return null; }
        }).find(value => value?.fixtureDone);
        expect(final).toEqual({fixtureDone:true,resolutions:mode === "ready" ? 1 : 0,sends:mode === "ready" ? 1 : 0});
        const files = mode === "disabled" ? await readdir(directory) : await readdir(statePath);
        expect(files.length).toBe(mode === "ready" ? 1 : 0);
      } finally { await rm(directory, {recursive:true,force:true}); }
    });
  }
});
