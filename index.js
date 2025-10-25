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

const express = require('express');
const { createAndShareInvoice, verifyWebhookSignature } = require('./paypal');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Allowed users for seller commands
const ALLOWED_USERS = ['1116953633364398101', '456358634868441088'];

// Proofs channel
const PROOFS_CHANNEL_ID = '1406121226367275008';

// Emojis
const EMOJI_THANKYOU = '<:heartssss:1410132419524169889>';
const EMOJI_VOUCH = '<:Cart:1421198487684648970>';

// Roblox private server links
const PVB_LINK = process.env.PVB_LINK || '';
const GAG_LINK = process.env.GAG_LINK || '';

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

// ====== PREFIX COMMAND: !purchase ======
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
    .addFields(
      { name: 'Buyer', value: buyer, inline: true },
      { name: 'Item(s)', value: item }
    )
    .setFooter({ text: 'Thanks for buying! – ysl' })
    .setTimestamp();

  if (attachmentFile) embed.setImage(`attachment://${attachmentFile.name}`);

  const proofsChannel = message.guild.channels.cache.get(PROOFS_CHANNEL_ID);
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

// ====== SLASH COMMANDS ======
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  console.log(`[interaction] name=${interaction.commandName} user=${interaction.user.id}`);

  // /ping
  if (interaction.commandName === 'ping') {
    return interaction.reply({ content: 'pong', flags: MessageFlags.Ephemeral });
  }

  // /completeorder
  if (interaction.commandName === 'completeorder') {
    if (!ALLOWED_USERS.includes(interaction.user.id))
      return interaction.reply({ content: '❌ You do not have permission.', flags: MessageFlags.Ephemeral });

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
      .setTimestamp()
      .setImage(proofAttachment.url);

    const proofsChannel = interaction.guild.channels.cache.get(PROOFS_CHANNEL_ID);
    if (!proofsChannel)
      return interaction.reply({ content: '⚠️ Proofs channel not found.', flags: MessageFlags.Ephemeral });

    const content =
      `## Thank you for your purchase <@${buyer.id}> ${EMOJI_THANKYOU}\n` +
      `## Please leave us a vouch! ${EMOJI_VOUCH}`;

    await proofsChannel.send({ content, embeds: [embed] });
    return interaction.reply({ content: '✅ Proof posted.', flags: MessageFlags.Ephemeral });
  }

  // /pvbserver
  if (interaction.commandName === 'pvbserver') {
    if (!ALLOWED_USERS.includes(interaction.user.id))
      return interaction.reply({ content: '❌ You do not have permission.', flags: MessageFlags.Ephemeral });

    if (!PVB_LINK)
      return interaction.reply({ content: '⚠️ Missing PVB_LINK in Railway.', flags: MessageFlags.Ephemeral });

    const embed = new EmbedBuilder()
      .setColor(0x00a2ff)
      .setTitle('PVB Private Server')
      .setDescription(`Here’s the PVB link:\n${PVB_LINK}`);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Join Private Server').setStyle(ButtonStyle.Link).setURL(PVB_LINK)
    );

    return interaction.reply({ embeds: [embed], components: [row] });
  }

  // /gagserver
  if (interaction.commandName === 'gagserver') {
    if (!ALLOWED_USERS.includes(interaction.user.id))
      return interaction.reply({ content: '❌ You do not have permission.', flags: MessageFlags.Ephemeral });

    if (!GAG_LINK)
      return interaction.reply({ content: '⚠️ Missing GAG_LINK in Railway.', flags: MessageFlags.Ephemeral });

    const embed = new EmbedBuilder()
      .setColor(0x00c853)
      .setTitle('GAG Private Server')
      .setDescription(`Here’s the GAG link:\n${GAG_LINK}`);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Join GAG Private Server').setStyle(ButtonStyle.Link).setURL(GAG_LINK)
    );

    return interaction.reply({ embeds: [embed], components: [row] });
  }

  // /invoice (USD only)
  if (interaction.commandName === 'invoice') {
    if (!ALLOWED_USERS.includes(interaction.user.id))
      return interaction.reply({ content: '❌ You do not have permission.', flags: MessageFlags.Ephemeral });

    await interaction.deferReply();
    const itemName = interaction.options.getString('item');
    const howmuch = interaction.options.getNumber('howmuch');
    if (howmuch <= 0) return interaction.editReply('⚠️ Amount must be greater than 0.');

    const amountUSD = howmuch.toFixed(2);
    try {
      const reference = JSON.stringify({
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        invokerId: interaction.user.id
      });

      const { id, payLink } = await createAndShareInvoice({
        itemName,
        amountUSD,
        reference
      });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Pay Invoice').setStyle(ButtonStyle.Link).setURL(payLink)
      );

      await interaction.editReply({
        content: `Invoice **${id}** for **${itemName}** (${amountUSD} USD).`,
        components: [row]
      });
    } catch (e) {
      console.error('[invoice] error:', e);
      await interaction.editReply('⚠️ Could not create/send the invoice. Check PayPal env vars.');
    }
  }
});

// ====== WEBHOOK SERVER ======
const app = express();
app.use(express.json({ type: '*/*' }));

app.post('/paypal/webhook', async (req, res) => {
  try {
    console.log('[webhook] event:', req.body?.event_type);
    const ok = await verifyWebhookSignature(req);
    console.log('[webhook] verification:', ok ? '✅ passed' : '❌ failed');

    if (!ok) return res.status(400).end();

    const ev = req.body;
    if (ev?.event_type === 'INVOICING.INVOICE.PAID') {
      const invoiceId = ev?.resource?.id;
      const ref = ev?.resource?.detail?.reference;
      let channelId = null;
      try { channelId = JSON.parse(ref).channelId; } catch {}

      if (channelId) {
        const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
        if (channel) {
          await channel.send(`✅ **Paid** — Invoice \`${invoiceId}\` has been paid.`);
          console.log('[webhook] posted confirmation in Discord');
        } else {
          console.log('[webhook] could not find channel');
        }
      }
    }
  } catch (err) {
    console.error('[webhook] handler error:', err);
  }
  res.status(200).end();
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('[webhook] listening on port', PORT));

// ====== ERROR HANDLING & LOGIN ======
process.on('unhandledRejection', (err) => console.error('[global] Unhandled Rejection:', err));
process.on('uncaughtException', (err) => console.error('[global] Uncaught Exception:', err));
client.on('error', (err) => console.error('[client] error:', err));
client.on('shardError', (err) => console.error('[client] shardError:', err));

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) console.error('❌ Missing BOT_TOKEN env var.');
else {
  console.log('BOT_TOKEN detected. Attempting login…');
  client.login(TOKEN).then(() => console.log('Login promise resolved.'));
}
