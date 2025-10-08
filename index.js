const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Only these users can run !purchase or /completeorder
const ALLOWED_USERS = ['1116953633364398101', '456358634868441088'];

// ID of your proofs channel
const PROOFS_CHANNEL_ID = '1406121226367275008';

// Emojis
const EMOJI_THANKYOU = '<:heartssss:1410132419524169889>';
const EMOJI_VOUCH = '<:Cart:1421198487684648970>';

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// ========== PREFIX COMMAND: !purchase ==========
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.content.startsWith('!purchase')) {
    // permission check
    if (!ALLOWED_USERS.includes(message.author.id)) {
      return message.reply('❌ You don’t have permission to run this command.');
    }

    const args = message.content.split(' ');
    if (args.length < 3) {
      return message.reply('Usage: `!purchase @Buyer ItemName` (attach image for proof)');
    }

    const buyer = args[1];
    const item = args.slice(2).join(' ');

    // optional attachment (re-upload it so everyone can see it)
    let attachmentFile = null;
    if (message.attachments.size > 0) {
      const a = message.attachments.first();
      attachmentFile = { attachment: a.url, name: a.name || 'proof.png' };
    }

    // build the embed
    const embed = new EmbedBuilder()
      .setColor(0xf98df2)
      .setTitle('Purchase Confirmed! 🎉')
      .addFields(
        { name: 'Buyer', value: buyer, inline: true },
        { name: 'Item(s)', value: item }
      )
      .setFooter({ text: 'Thanks for buying! – ysl' })
      .setTimestamp();

    if (attachmentFile) {
      embed.setImage(`attachment://${attachmentFile.name}`);
    }

    // find proofs channel
    const proofsChannel = message.guild.channels.cache.get(PROOFS_CHANNEL_ID);
    if (!proofsChannel) {
      return message.reply('⚠️ Could not find the proofs channel.');
    }

    // one message: content + embed (+ file)
    const content =
      `**Thank you for your purchase ${buyer} ${EMOJI_THANKYOU}**\n` +
      `**We hope you’re happy with your purchase! Please leave us a vouch. ${EMOJI_VOUCH}**`;

    try {
      if (attachmentFile) {
        await proofsChannel.send({
          content,
          embeds: [embed],
          files: [attachmentFile]
        });
      } else {
        await proofsChannel.send({ content, embeds: [embed] });
      }
    } catch (err) {
      console.error('Error sending proof message:', err);
      await message.reply('⚠️ Failed to post in #proofs (check bot permissions and file size).');
    }
  }
});

// ========== SLASH COMMAND: /completeorder ==========
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'completeorder') return;

  // permission check
  if (!ALLOWED_USERS.includes(interaction.user.id)) {
    return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
  }

  const buyer = interaction.options.getUser('buyer');
  const item = interaction.options.getString('item');
  const proofAttachment = interaction.options.getAttachment('proof'); // required

  const embed = new EmbedBuilder()
    .setColor(0xf98df2)
    .setTitle('Purchase Confirmed! 🎉')
    .addFields(
      { name: 'Buyer', value: `<@${buyer.id}>`, inline: true },
      { name: 'Item(s)', value: item }
    )
    .setFooter({ text: 'Thanks for buying! – ysl' })
    .setTimestamp();

  // re-upload file so everyone can see it
  const file = { attachment: proofAttachment.url, name: proofAttachment.name || 'proof.png' };
  embed.setImage(`attachment://${file.name}`);

  const proofsChannel = interaction.guild.channels.cache.get(PROOFS_CHANNEL_ID);
  if (!proofsChannel) {
    return interaction.reply({ content: '⚠️ Could not find the proofs channel.', ephemeral: true });
  }

  const content =
    `## Thank you for your purchase <@${buyer.id}> ${EMOJI_THANKYOU}\n` +
    `## We hope you’re happy with your purchase! Please leave us a vouch. ${EMOJI_VOUCH}`;

  try {
    // private confirmation so the slash UI stops spinning
    await interaction.reply({ content: '✅ Posted your proof in #proofs.', ephemeral: true });

    // public message (single message)
    await proofsChannel.send({
      content,
      embeds: [embed],
      files: [file]
    });
  } catch (err) {
    console.error('Error sending proof message:', err);
    if (!interaction.replied) {
      await interaction.reply({ content: '⚠️ Failed to post in #proofs (check bot permissions and file size).', ephemeral: true });
    }
  }
});

// ===== KEEP THIS AT THE VERY BOTTOM =====
client.login(process.env.BOT_TOKEN); // <-- replace with your token and keep the quotes
