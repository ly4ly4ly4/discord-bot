const { REST, Routes, SlashCommandBuilder } = require('discord.js');

// MUST match the app/bot that is online
const token   = process.env.BOT_TOKEN;            // same token your running bot uses
const clientId = '1421187460083486971';           // Application (bot) ID
const guildId  = '1406101210984874095';           // Your server ID

const commands = [
  // /completeorder
  new SlashCommandBuilder()
    .setName('completeorder')
    .setDescription('Post a completed order to the proofs channel')
    .addUserOption(o =>
      o.setName('buyer').setDescription('Buyer').setRequired(true))
    .addStringOption(o =>
      o.setName('item').setDescription('Item purchased').setRequired(true))
    .addAttachmentOption(o =>
      o.setName('proof').setDescription('Proof screenshot').setRequired(true)),

  // /pvbserver
  new SlashCommandBuilder()
    .setName('pvbserver')
    .setDescription('Get the Roblox private server link'),

  // /ping - quick health check
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Replies with pong'),
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
    console.error('Register error:', err);
  }
})();
