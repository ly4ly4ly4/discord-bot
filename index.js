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
const { createAndShareInvoice, verifyWebhookSignature, getInvoiceById } = require('./paypal');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ===== Config =====
const ALLOWED_USERS = ['1116953633364398101', '456358634868441088']; // who can run seller cmds
const PROOFS_CHANNEL_ID = '1406121226367275008';                     // your proofs channel
const PAID_CHANNEL_ID = process.env.PAID_CHANNEL_ID || null;         // optional override

// Emojis
const EMOJI_THANKYOU = '<:heartssss:1410132419524169889>';
const EMOJI_VOUCH = '<:Cart:1421198487684648970>';

// Roblox links (optional)
const PVB_LINK = process.env.PVB_LINK || '';
const GAG_LINK = process.env.GAG_LINK || '';

// ===== In-memory invoice map =====
const runtimeInvoiceMap = new Map(); // invoiceId => channelId
const rememberInvoiceChannel = (invoiceId, channelId) => {
  runtimeInvoiceMap.set(invoiceId, channelId);
  console.log('[map] remember', invoiceId, '→', channelId, '(size:', runtimeInvoiceMap.size, ')');
  setTimeout(() => {
    runtimeInvoiceMap.delete(invoiceId);
    console.log('[map] expired', invoiceId, '(size:', runtimeInvoiceMap.size, ')');
  }, 7 * 24 * 60 * 60 * 1000);
};

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

// ===== SLASH COMMANDS =====
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  console.log(`[interaction] name=${interaction.commandName} user=${interaction.user?.id}`);

  // /ping
  if (interaction.commandName === 'ping') {
    return interaction.reply({ content: 'pong', flags: MessageFlags.Ephemeral });
  }

  // /completeorder
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
      .setTimestamp()
      .setImage(proofAttachment.url);

    const proofsChannel = interaction.guild.channels.cache.get(PROOFS_CHANNEL_ID);
    if (!proofsChannel) {
      return interaction.reply({ content: '⚠️ Could not find the proofs channel.', flags: MessageFlags.Ephemeral });
    }

    const content =
      `## Thank you for your purchase <@${buyer.id}> ${EMOJI_THANKYOU}\n` +
      `## We hope you’re happy with your purchase! Please leave us a vouch. ${EMOJI_VOUCH}`;

    await proofsChannel.send({ content, embeds: [embed] });
    return interaction.reply({ content: '✅ Posted your proof in #proofs.', flags: MessageFlags.Ephemeral });
  }

  // /pvbserver
  if (interaction.commandName === 'pvbserver') {
    if (!ALLOWED_USERS.includes(interaction.user.id)) {
      return interaction.reply({ content: '❌ You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
    }
    if (!PVB_LINK) {
      return interaction.reply({ content: '⚠️ The private server link is not set (PVB_LINK).', flags: MessageFlags.Ephemeral });
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
      return interaction.reply({ content: '❌ You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
    }
    if (!GAG_LINK) {
      return interaction.reply({ content: '⚠️ The GAG private server link is not set (GAG_LINK).', flags: MessageFlags.Ephemeral });
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

  // /invoice (USD)
  if (interaction.commandName === 'invoice') {
    if (!ALLOWED_USERS.includes(interaction.user.id)) {
      return interaction.reply({ content: '❌ You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();

    const itemName = interaction.options.getString('item');
    const howmuch  = interaction.options.getNumber('howmuch');

    if (howmuch <= 0) {
      return interaction.editReply('⚠️ Amount must be greater than 0.');
    }

    const amountUSD = howmuch.toFixed(2);

    try {
      const reference = JSON.stringify({
        guildId: interaction.guildId,
        channelId: interaction.channelId,   // original ticket/channel
        invokerId: interaction.user.id
      });

      const { id, payLink } = await createAndShareInvoice({
        itemName,
        amountUSD, // Always USD
        reference
      });

      rememberInvoiceChannel(id, interaction.channelId);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Pay Invoice').setStyle(ButtonStyle.Link).setURL(payLink)
      );

      await interaction.editReply({
        content: `Invoice **${id}** for **${itemName}** (${amountUSD} USD). Share this link with the buyer:`,
        components: [row]
      });
    } catch (e) {
      console.error('[invoice] error:', e);
      await interaction.editReply('⚠️ Could not create/send the invoice. Check PayPal env vars & Railway logs.');
    }
    return;
  }
});

// ===== HTTP SERVER (PayPal Webhook) =====
const app = express();
app.use(express.json({ type: '*/*' })); // accept JSON

// optional health
app.get('/', (_req, res) => res.send('OK'));

// ==== Post in original ticket + fallback channel ====
app.post('/paypal/webhook', async (req, res) => {
  try {
    const ev = req.body;
    console.log('[webhook] event:', ev?.event_type);

    const ok = await verifyWebhookSignature(req);
    console.log('[webhook] verification:', ok ? '✅ passed' : '❌ failed');

    // ACK quickly
    res.status(200).end();
    if (!ok) return;

    if (ev?.event_type !== 'INVOICING.INVOICE.PAID') return;

    const resource = ev?.resource || {};
    console.log('[webhook] map size before:', runtimeInvoiceMap.size);

    // 1) Resolve invoiceId from many places (including href)
    let invoiceId =
      resource.id ||
      resource.invoice_id ||
      resource?.detail?.invoice_id ||
      resource?.detail?.invoice_number ||
      null;

    if (!invoiceId) {
      const href =
        resource.href ||
        (Array.isArray(resource.links)
          ? (resource.links.find(l => l.rel === 'self' || l.rel === 'detail')?.href || null)
          : null);
      if (href) {
        const m = href.match(/\/invoices\/([^/?#]+)/i);
        if (m) invoiceId = m[1];
      }
    }

    console.log('[webhook] invoiceId resolved:', invoiceId || '(unknown)');

    // 2) Try to recover channel from event reference
    let channelFromRef = null;
    let refRaw =
      resource?.detail?.reference ??
      resource?.detail?.invoice_number ??
      null;
    console.log('[webhook] refRaw (from event):', refRaw);

    if (typeof refRaw === 'string') {
      try {
        const parsed = JSON.parse(refRaw);
        if (parsed?.channelId) channelFromRef = parsed.channelId;
      } catch {}
      if (!channelFromRef) {
        const m = refRaw.match(/ch_(\d{17,20})/);
        if (m) channelFromRef = m[1];
      }
    }

    // 3) Also try in-memory map
    const channelFromMap =
      runtimeInvoiceMap.get((resource.id || resource.invoice_id || invoiceId || '').toString()) || null;
    if (channelFromMap) {
      console.log('[webhook] recovered channel from map:', channelFromMap);
    }

    // 4) If still no channel, fetch invoice and read its reference/invoice_number
    if (!channelFromRef && invoiceId) {
      try {
        const inv = await getInvoiceById(invoiceId);
        const invRef = inv?.detail?.reference || null;
        const invNum = inv?.detail?.invoice_number || null;
        console.log('[webhook] fetched invoice; reference:', invRef, 'invoice_number:', invNum);

        if (typeof invRef === 'string') {
          try {
            const parsed = JSON.parse(invRef);
            if (parsed?.channelId) channelFromRef = parsed.channelId;
          } catch {}
        }
        if (!channelFromRef && typeof invNum === 'string') {
          const m = invNum.match(/ch_(\d{17,20})/);
          if (m) channelFromRef = m[1];
        }
      } catch (e) {
        console.log('[webhook] getInvoiceById failed:', e?.message || e);
      }
    }

    // 5) Build list of channels to notify: original ticket (if found) + staff
    const fallbackChannelId = PAID_CHANNEL_ID || PROOFS_CHANNEL_ID || null;
    const notifyIds = [...new Set([channelFromRef, channelFromMap, fallbackChannelId].filter(Boolean))];
    console.log('[webhook] notifying channels:', notifyIds);

    if (notifyIds.length === 0) {
      console.log('[webhook] no channels available; set PAID_CHANNEL_ID or PROOFS_CHANNEL_ID');
      return;
    }

    const amount =
      resource?.amount?.value && resource?.amount?.currency_code
        ? `${resource.amount.value} ${resource.amount.currency_code}`
        : null;

    const msg = amount
      ? `✅ **Paid** — Invoice \`${invoiceId || '(unknown)'}\` has been paid (**${amount}**).`
      : `✅ **Paid** — Invoice \`${invoiceId || '(unknown)'}\` has been paid.`;

    for (const id of notifyIds) {
      try {
        const ch = client.channels.cache.get(id) || await client.channels.fetch(id);
        if (ch) {
          await ch.send(msg);
          console.log('[webhook] posted confirmation in channel', id);
        } else {
          console.log('[webhook] channel not found', id);
        }
      } catch (e) {
        console.log('[webhook] send error for channel', id, e?.message || e);
      }
    }
  } catch (err) {
    console.error('[webhook] handler error:', err);
    try { res.status(200).end(); } catch {}
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('[webhook] listening on port', PORT));

process.on('unhandledRejection', (err) => console.error('[global] Unhandled Rejection:', err));
process.on('uncaughtException', (err) => console.error('[global] Uncaught Exception:', err));
client.on('error', (err) => console.error('[client] error:', err));
client.on('shardError', (err) => console.error('[client] shardError:', err));

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN || TOKEN.trim().length === 0) {
  console.error('❌ Missing BOT_TOKEN env var. Set it in Railway → Variables.');
} else {
  console.log('BOT_TOKEN detected. Attempting login…');
  client.login(TOKEN)
    .then(() => console.log('Login promise resolved.'))
    .catch((err) => {
      console.error('❌ Login failed:', err);
      setTimeout(() => process.exit(1), 15000);
    });
}
