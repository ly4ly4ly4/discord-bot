const { REST, Routes, SlashCommandBuilder } = require('discord.js');

// ↓↓↓ Fill these with YOUR values ↓↓↓
const token = process.env.BOT_TOKEN;              // set in your terminal when running locally
const clientId = '1421187460083486971';           // Application ID (Dev Portal → General Information)
const guildId = '1406101210984874095';            // Your Server (Guild) ID
// ↑↑↑ Fill these with YOUR values ↑↑↑

const commands = [
  // /completeorder (existing)
  new SlashCommandBuilder()
    .setName('completeorder')
    .setDescription('Post a completed order to the proofs channel')
    .addUserOption(opt =>
      opt.setName('buyer').setDescription('Buyer').setRequired(true))
    .addStringOption(opt =>
      opt.setName('item').setDescription('Item purchased').setRequired(true))
    .addAttachmentOption(opt =>
      opt.setName('proof').setDescription('Proof screenshot').setRequired(true)),

  // /pvbserver (new)
  new SlashCommandBuilder()
    .setName('pvbserver')
    .setDescription('Get the Roblox private server link')
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log('Registering slash commands…');
    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: commands }
    );
    console.log('Slash commands registered ✅');
  } catch (err) {
    console.error(err);
  }
})();
