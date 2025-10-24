const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Only these users can run !purchase or /completeorder or /pvbserver or /gagserver
const ALLOWED_USERS = ['1116953633364398101', '456358634868441088'];

// ID of your proofs channel
const PROOFS_CHANNEL_ID = '1406121226367275008';

// Emojis
const EMOJI_THANKYOU = '<:heartssss:1410132419524169889>';
const EMOJI_VOUCH = '<:Cart:1421198487684648970>';

// Roblox private server links (Railway → Variables)
const PVB_LINK = process.env.PVB_LINK || '';
const GAG_LINK = process.env.GAG_LINK || '';   // <<< NEW

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

// ========== PREFIX COMMAND: !purchase ==========
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.content.startsWith('!purchase')) {
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
      .addFields(
        { name: 'Buyer', value: buyer, inline: true },
        { name: 'Item(s)', value: item }
      )
      .setFooter({ text: 'Thanks for buying! – ysl' })
      .setTimestamp();

    if (attachmentFile) embed.setImage(`attachment://${attachmentFile.name}`);

    const proofsChannel = message.guild.channels.cache.get(PROOFS_CHANNEL_ID);
    if (!proofsChannel) {
      return message.reply('⚠️ Could not find the proofs channel.');
    }

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
  }
});

// ========== SLASH COMMANDS ==========
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    console.log(`[interaction] isChatInput=${interaction.isChatInputCommand?.()} name=${interaction.commandName || 'n/a'} user=${interaction.user?.id || 'n/a'} guild=${interaction.guildId || 'DM'}`);
  } catch {}

  if (!interaction.isChatInputCommand()) return;

  // ---- /ping ----
  if (interaction.commandName === 'ping') {
    console.log('[ping] invoked by', interaction.user.id, interaction.user.tag);
    return interaction.reply({ content: 'pong', flags: MessageFlags.Ephemeral });
  }

  // ---- /completeorder ----
  if (interaction.commandName === 'completeorder') {
    if (!ALLOWED_USERS.includes(interaction.user.id)) {
      return interaction.reply({ content: '❌ You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
    }

    const buyer = interaction.options.getUser('buyer');
    const item = interaction.options.getString('item');
    const proofAttachment = interaction.options.getAttachment('proof');

    const embed = new EmbedBuilder()
      .setColor(0xf98df2)
      .setTitle('Purchase Confirmed! 🎉')
      .addFields(
        { name: 'Buyer', value: `<@${buyer.id}>`, inline: true },
        { name: 'Item(s)', value: item }
      )
      .setFooter({ text: 'Thanks for buying! – ysl' })
      .setTimestamp();

    const file = { attachment: proofAttachment.url, name: proofAttachment.name || 'proof.png' };
    embed.setImage(`attachment://${file.name}`);

    const proofsChannel = interaction.guild.channels.cache.get(PROOFS_CHANNEL_ID);
    if (!proofsChannel) {
      return interaction.reply({ content: '⚠️ Could not find the proofs channel.', flags: MessageFlags.Ephemeral });
    }

    const content =
      `## Thank you for your purchase <@${buyer.id}> ${EMOJI_THANKYOU}\n` +
      `## We hope you’re happy with your purchase! Please leave us a vouch. ${EMOJI_VOUCH}`;

    try {
      await interaction.reply({ content: '✅ Posted your proof in #proofs.', flags: MessageFlags.Ephemeral });
      await proofsChannel.send({ content, embeds: [embed], files: [file] });
    } catch (err) {
      console.error('Error sending proof message:', err);
      if (!interaction.replied) {
        await interaction.reply({ content: '⚠️ Failed to post in #proofs (check bot permissions and file size).', flags: MessageFlags.Ephemeral });
      }
    }
    return;
  }

  // ---- /pvbserver ----
  if (interaction.commandName === 'pvbserver') {
    try {
      console.log('[pvbserver] invoked by', interaction.user.id, interaction.user.tag);

      if (!ALLOWED_USERS.includes(interaction.user.id)) {
        console.log('[pvbserver] blocked: not allowed');
        return interaction.reply({
          content: '❌ You do not have permission to use this command.',
          flags: MessageFlags.Ephemeral
        });
      }

      await interaction.deferReply(); // public response later

      if (!PVB_LINK) {
        console.log('[pvbserver] missing PVB_LINK env var');
        return interaction.editReply('⚠️ The private server link is not set yet. Ask an admin to set the `PVB_LINK` variable in Railway.');
      }

      const embed = new EmbedBuilder()
        .setColor(0x00a2ff)
        .setTitle('Roblox Private Server')
        .setDescription(`Here’s the private server link, please state your username before joining:\n${PVB_LINK}`)
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('Join Private Server')
          .setStyle(ButtonStyle.Link)
          .setURL(PVB_LINK)
      );

      await interaction.editReply({ embeds: [embed], components: [row] });
      console.log('[pvbserver] reply sent');
    } catch (err) {
      console.error('[pvbserver] error', err);
      if (interaction.deferred && !interaction.replied) {
        await interaction.editReply('⚠️ Something went wrong while sending the link.');
      } else if (!interaction.replied) {
        await interaction.reply({ content: '⚠️ Something went wrong while sending the link.', flags: MessageFlags.Ephemeral });
      }
    }
    return;
  }

  // ---- /gagserver (NEW) ----
  if (interaction.commandName === 'gagserver') {
    try {
      console.log('[gagserver] invoked by', interaction.user.id, interaction.user.tag);

      if (!ALLOWED_USERS.includes(interaction.user.id)) {
        console.log('[gagserver] blocked: not allowed');
        return interaction.reply({
          content: '❌ You do not have permission to use this command.',
          flags: MessageFlags.Ephemeral
        });
      }

      await interaction.deferReply(); // public

      if (!GAG_LINK) {
        console.log('[gagserver] missing GAG_LINK env var');
        return interaction.editReply('⚠️ The GAG private server link is not set yet. Ask an admin to set the `GAG_LINK` variable in Railway.');
      }

      const embed = new EmbedBuilder()
        .setColor(0x00c853)
        .setTitle('GAG Private Server')
        .setDescription(`Here’s the GAG private server link, please state your username before joining:\n${GAG_LINK}`)
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('Join GAG Private Server')
          .setStyle(ButtonStyle.Link)
          .setURL(GAG_LINK)
      );

      await interaction.editReply({ embeds: [embed], components: [row] });
      console.log('[gagserver] reply sent');
    } catch (err) {
      console.error('[gagserver] error', err);
      if (interaction.deferred && !interaction.replied) {
        await interaction.editReply('⚠️ Something went wrong while sending the link.');
      } else if (!interaction.replied) {
        await interaction.reply({ content: '⚠️ Something went wrong while sending the link.', flags: MessageFlags.Ephemeral });
      }
    }
    return;
  }
});

// ===== KEEP THIS AT THE VERY BOTTOM =====

// Global error handlers
process.on('unhandledRejection', (err) => {
  console.error('[global] Unhandled Rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('[global] Uncaught Exception:', err);
});
client.on('error', (err) => console.error('[client] error:', err));
client.on('shardError', (err) => console.error('[client] shardError:', err));

const TOKEN = process.env.BOT_TOKEN;

if (!TOKEN || TOKEN.trim().length === 0) {
  console.error('❌ Missing BOT_TOKEN env var. Set it in Railway → Variables (or Shared Variables linked to this service).');
} else {
  console.log('BOT_TOKEN detected. Attempting login…');
}

client.login(TOKEN)
  .then(() => console.log('Login promise resolved.'))
  .catch((err) => {
    console.error('❌ Login failed:', err);
    setTimeout(() => process.exit(1), 15000);
  });
