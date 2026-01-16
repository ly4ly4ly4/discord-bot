// index.js — proofs + utility commands (NO PayPal / NO invoices)
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
} = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// ===== Config =====
const ALLOWED_USERS = ['1116953633364398101', '456358634868441088'];
const PROOFS_CHANNEL_ID = '1406121226367275008';

// Emojis
const EMOJI_THANKYOU = '<:heartssss:1410132419524169889>';
const EMOJI_VOUCH = '<:Cart:1421198487684648970>';

// Roblox links (optional)
const PVB_LINK = process.env.PVB_LINK || '';
const GAG_LINK = process.env.GAG_LINK || '';

// ===== Bot ready =====
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log('RAILWAY_GIT_COMMIT_SHA:', process.env.RAILWAY_GIT_COMMIT_SHA || '(none)');
  console.log('RAILWAY_GIT_BRANCH:', process.env.RAILWAY_GIT_BRANCH || '(none)');
  try {
    const cmds = await client.application.commands.fetch();
    console.log('Loaded application commands:', [...cmds.values()].map(c => c.name).join(', ') || '(none)');
  } catch (e) {
    console.log('Could not fetch application commands at ready:', e?.message || e);
  }
});

// ===== PREFIX: !purchase =====
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith('!purchase')) return;

  if (!ALLOWED_USERS.includes(message.author.id)) {
    return message.reply('❌ You don’t have permission to run this command.');
  }

  const args = message.content.split(' ');
  if (args.length < 3) {
    return message.reply('Usage: `!purchase @Buyer ItemName` (attach image for proof)');
  }

  const buyer = args[1];
  const item = args.slice(2).join(' ');

  let attachmentFile = null;
  if (message.attachments.size > 0) {
    const a = message.attachments.first();
    attachmentFile = { attachment: a.url, name: a.name || 'proof.png' };
  }

  const embed = new EmbedBuilder()
    .setColor(0xf98df2)
    .setTitle('Purchase Confirmed! 🎉')
    .addFields({ name: 'Buyer', value: buyer, inline: true }, { name: 'Item(s)', value: item })
    .setFooter({ text: 'Thanks for buying! – ysl' })
    .setTimestamp();

  if (attachmentFile) embed.setImage(`attachment://${attachmentFile.name}`);

  const proofsChannel =
    message.guild.channels.cache.get(PROOFS_CHANNEL_ID) ||
    (await message.guild.channels.fetch(PROOFS_CHANNEL_ID).catch(() => null));
  if (!proofsChannel) return message.reply('⚠️ Could not find the proofs channel.');

  const content =
    `**Thank you for your purchase ${buyer} ${EMOJI_THANKYOU}**\n` +
    `**We hope you’re happy with your purchase! Please leave us a vouch. ${EMOJI_VOUCH}**`;

  try {
    if (attachmentFile) {
      await proofsChannel.send({ content, embeds: [embed], files: [attachmentFile] });
    } else {
      await proofsChannel.send({ content, embeds: [embed] });
    }
  } catch (err) {
    console.error('Error sending proof message:', err);
    await message.reply('⚠️ Failed to post in #proofs (check bot permissions and file size).');
  }
});

// ===== SLASH COMMANDS =====
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  console.log(`[interaction] name=${interaction.commandName} user=${interaction.user?.id}`);

  // /ping
  if (interaction.commandName === 'ping') {
    return interaction.reply({ content: 'pong', ephemeral: true });
  }

  // /completeorder
  if (interaction.commandName === 'completeorder') {
    if (!ALLOWED_USERS.includes(interaction.user.id)) {
      return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
    }

    const buyer = interaction.options.getUser('buyer');
    const item = interaction.options.getString('item');
    const proofAttachment = interaction.options.getAttachment('proof');

    const embed = new EmbedBuilder()
      .setColor(0xf98df2)
      .setTitle('Purchase Confirmed! 🎉')
      .addFields({ name: 'Buyer', value: `<@${buyer.id}>`, inline: true }, { name: 'Item(s)', value: item })
      .setFooter({ text: 'Thanks for buying! – ysl' })
      .setTimestamp();

    // ✅ Permanent proof: upload as a file + use attachment:// in embed
    let files = [];
    if (proofAttachment?.url) {
      const filename = proofAttachment.name || 'proof.png';
      files = [{ attachment: proofAttachment.url, name: filename }];
      embed.setImage(`attachment://${filename}`);
    }

    const proofsChannel =
      interaction.guild.channels.cache.get(PROOFS_CHANNEL_ID) ||
      (await interaction.guild.channels.fetch(PROOFS_CHANNEL_ID).catch(() => null));
    if (!proofsChannel) {
      return interaction.reply({ content: '⚠️ Could not find the proofs channel.', ephemeral: true });
    }

    const content =
      `## Thank you for your purchase <@${buyer.id}> ${EMOJI_THANKYOU}\n` +
      `## We hope you’re happy with your purchase! Please leave us a vouch. ${EMOJI_VOUCH}`;

    await proofsChannel.send({ content, embeds: [embed], files });
    return interaction.reply({ content: '✅ Posted your proof in #proofs.', ephemeral: true });
  }

  // /pvbserver
  if (interaction.commandName === 'pvbserver') {
    if (!ALLOWED_USERS.includes(interaction.user.id)) {
      return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
    }
    if (!PVB_LINK) {
      return interaction.reply({ content: '⚠️ The private server link is not set (PVB_LINK).', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setColor(0x00a2ff)
      .setTitle('PVB Private Server')
      .setDescription(`Here’s the PVB private server link, please state your username before joining:\n${PVB_LINK}`)
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Join Private Server').setStyle(ButtonStyle.Link).setURL(PVB_LINK)
    );

    return interaction.reply({ embeds: [embed], components: [row] });
  }

  // /gagserver
  if (interaction.commandName === 'gagserver') {
    if (!ALLOWED_USERS.includes(interaction.user.id)) {
      return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
    }
    if (!GAG_LINK) {
      return interaction.reply({ content: '⚠️ The GAG private server link is not set (GAG_LINK).', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setColor(0x00c853)
      .setTitle('GAG Private Server')
      .setDescription(`Here’s the GAG private server link, please state your username before joining:\n${GAG_LINK}`)
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Join GAG Private Server').setStyle(ButtonStyle.Link).setURL(GAG_LINK)
    );

    return interaction.reply({ embeds: [embed], components: [row] });
  }
});

// ===== Error handlers & login =====
process.on('unhandledRejection', (err) => console.error('[global] Unhandled Rejection:', err));
process.on('uncaughtException', (err) => console.error('[global] Uncaught Exception:', err));
client.on('error', (err) => console.error('[client] error:', err));
client.on('shardError', (err) => console.error('[client] shardError:', err));

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN || TOKEN.trim().length === 0) {
  console.error('❌ Missing BOT_TOKEN env var. Set it in Railway → Variables.');
} else {
  console.log('BOT_TOKEN detected. Attempting login…');
  client
    .login(TOKEN)
    .then(() => console.log('Login promise resolved.'))
    .catch((err) => {
      console.error('❌ Login failed:', err);
      setTimeout(() => process.exit(1), 15000);
    });
}
