import { REST, Routes } from "discord.js";
import { commandData } from "./command.js";
import { loadGalleryConfig } from "./config.js";

const config = loadGalleryConfig();
const rest = new REST({ version: "10" }).setToken(config.discordBotToken);

await rest.put(
  Routes.applicationGuildCommands(config.discordApplicationId, config.discordGuildId),
  { body: commandData },
);

console.log(`Registered ${commandData.length} guild command for Reaper.`);
