import { WebSocket } from "ws";
global.WebSocket = WebSocket;

import { Client, MessageActionRow, MessageButton } from "discord.js-selfbot-v13";
import { Streamer, prepareStream, playStream, Utils } from "@dank074/discord-video-stream";
import dotenv from "dotenv";
import http from "http";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
dotenv.config();

const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("بوت السينيما شغال ✅");
  })
  .listen(PORT, () => console.log(`🌐 سيرفر شغال على منفذ ${PORT}`));

const PREFIX = process.env.PREFIX || "!";
const OWNER_ID = process.env.OWNER_ID || "1407727139251290223";

const streamer = new Streamer(new Client());

let state = {
  ffmpegProc: null,
  isStreaming: false,
  isPaused: false,
  startedAt: 0,
  pausedAt: 0,
  totalPausedMs: 0,
  seekBase: 0,
  videoUrl: null,
  subtitlePath: null,
  voiceChannel: null,
  controlMessage: null,
  currentName: null,
  savedVoiceChannelId: null,
  savedGuildId: null,
};

function isYoutubeUrl(url) {
  return url.includes("youtube.com") || url.includes("youtu.be");
}

async function resolveVideoUrl(url) {
  if (!isYoutubeUrl(url)) return url;
  try {
    const { stdout } = await execAsync(
      `yt-dlp -f "best[ext=mp4]/best" --get-url "${url}"`
    );
    const lines = stdout.trim().split("\n").filter(Boolean);
    return lines[0];
  } catch (e) {
    console.error("❌ خطأ yt-dlp:", e.message);
    throw new Error("ما قدرت أجيب رابط الفيديو من يوتيوب.");
  }
}

function elapsedSeconds() {
  if (!state.startedAt) return state.seekBase;
  const pausedMs = state.isPaused ? Date.now() - state.pausedAt : 0;
  const activeMs = Date.now() - state.startedAt - state.totalPausedMs - pausedMs;
  return state.seekBase + Math.max(0, activeMs / 1000);
}

function buildControlRow() {
  return new MessageActionRow().addComponents(
    new MessageButton().setCustomId("back10").setLabel("⏪ 10").setStyle("SECONDARY"),
    new MessageButton()
      .setCustomId("toggle_pause")
      .setLabel(state.isPaused ? "▶️ استمرار" : "⏸️ إيقاف مؤقت")
      .setStyle(state.isPaused ? "SUCCESS" : "PRIMARY"),
    new MessageButton().setCustomId("fwd10").setLabel("⏩ 10").setStyle("SECONDARY"),
    new MessageButton().setCustomId("stop_btn").setLabel("⏹️ إيقاف نهائي").setStyle("DANGER")
  );
}

async function sendOrUpdateControlPanel(channel) {
  const content = `🎬 **${state.currentName || "تشغيل"}**\nالوقت الحالي: ~${Math.floor(elapsedSeconds())} ثانية`;
  if (state.controlMessage) {
    try {
      await state.controlMessage.edit({ content, components: [buildControlRow()] });
      return;
    } catch (e) {}
  }
  state.controlMessage = await channel.send({ content, components: [buildControlRow()] });
}

async function startPlayback(voiceChannel, textChannel, videoUrl, subtitlePath, seekSeconds, displayName) {
  if (state.ffmpegProc) {
    try { state.ffmpegProc.kill("SIGKILL"); } catch {}
  }

  await streamer.joinVoice(voiceChannel.guild.id, voiceChannel.id);

  const ffmpegOptions = {
    frameRate: 30,
    bitrateVideo: 3000,
    bitrateVideoMax: 5000,
    videoCodec: Utils.normalizeVideoCodec("H264"),
    h26xPreset: "veryfast",
    height: 720,
  };

  if (seekSeconds > 0) {
    ffmpegOptions.customFfmpegFlags = ["-ss", String(seekSeconds)];
  }

  if (subtitlePath) {
    const escaped = subtitlePath.replace(/\\/g, "/").replace(/:/g, "\\:");
    ffmpegOptions.customFfmpegFlags = [
      ...(ffmpegOptions.customFfmpegFlags || []),
      "-vf", `scale=-2:720,subtitles='${escaped}'`
    ];
  }

  const { command, output } = prepareStream(videoUrl, ffmpegOptions);

  command.on("start", () => { state.ffmpegProc = command.ffmpegProc || null; });
  command.on("error", (err) => {
    console.error("❌ خطأ ffmpeg:", err.message);
    state.isStreaming = false;
  });

  state.isStreaming = true;
  state.isPaused = false;
  state.startedAt = Date.now();
  state.totalPausedMs = 0;
  state.seekBase = seekSeconds || 0;
  state.videoUrl = videoUrl;
  state.subtitlePath = subtitlePath;
  state.voiceChannel = voiceChannel;
  state.currentName = displayName;

  // camera مضمونة على Render
  playStream(output, streamer, { type: "camera" })
    .then(() => { state.isStreaming = false; })
    .catch((err) => {
      console.error("❌ camera فشل:", err.message);
      state.isStreaming = false;
    });

  await sendOrUpdateControlPanel(textChannel);
}

async function stopPlayback(textChannel) {
  if (state.ffmpegProc) {
    try { state.ffmpegProc.kill("SIGKILL"); } catch {}
  }
  state.ffmpegProc = null;
  state.isStreaming = false;
  state.isPaused = false;
  state.startedAt = 0;
  state.totalPausedMs = 0;
  state.seekBase = 0;
  try { await streamer.leaveVoice(); } catch {}
  if (state.controlMessage) {
    try { await state.controlMessage.edit({ content: "⏹️ تم إيقاف التشغيل.", components: [] }); } catch {}
  }
  state.controlMessage = null;
  state.currentName = null;
}

streamer.client.on("ready", () => {
  console.log(`✅ تم تسجيل الدخول بنجاح كـ ${streamer.client.user.tag}`);
});

streamer.client.on("messageCreate", async (message) => {
  console.log(`📩 رسالة من: ${message.author?.tag} (${message.author?.id}) | "${message.content}"`);
  if (!OWNER_ID || message.author.id !== OWNER_ID) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const cmd = args.shift().toLowerCase();

  try {

    // ===== !ادخل =====
    if (cmd === "ادخل") {
      const channelId = args[0]?.trim();
      if (!channelId) return message.reply("❌ حط ID قناة الصوت.\nمثال: `!ادخل 123456789`");

      const guild = message.guild;
      const voiceChannel = guild.channels.cache.get(channelId);
      if (!voiceChannel) return message.reply("❌ ما لقيت القناة. تأكد من الـ ID.");

      state.savedVoiceChannelId = channelId;
      state.savedGuildId = guild.id;

      await streamer.joinVoice(guild.id, channelId);
      await message.reply(`✅ دخلت القناة!\nالحين اكتب:\n\`!كام\``);

    // ===== !كام =====
    } else if (cmd === "كام") {
      if (!state.savedVoiceChannelId) return message.reply("❌ لازم تكتب `!ادخل ID` أول.");

      const guild2 = streamer.client.guilds.cache.get(state.savedGuildId);
      const voiceChannel2 = guild2?.channels.cache.get(state.savedVoiceChannelId);
      if (!voiceChannel2) return message.reply("❌ ما قدرت أوصل للقناة.");

      const ffmpegOptionsKam = {
        frameRate: 1,
        bitrateVideo: 100,
        bitrateVideoMax: 200,
        videoCodec: Utils.normalizeVideoCodec("H264"),
        h26xPreset: "ultrafast",
        height: 144,
      };
      const silentUrl = "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4";
      const { output: kamOutput } = prepareStream(silentUrl, ffmpegOptionsKam);
      playStream(kamOutput, streamer, { type: "camera" }).catch(() => {});
      await message.reply('✅ فتحت الكاميرا!\nالحين اكتب:\n`!تشغيل رابط`');

    // ===== !تشغيل =====
    } else if (cmd === "تشغيل") {
      const rawUrl = args.join(" ").trim();

      if (!rawUrl) return message.reply("❌ حط الرابط.\nمثال: `!تشغيل https://youtu.be/xxxxx`");
      if (!rawUrl.startsWith("http")) return message.reply("❌ الرابط غير صحيح.");
      if (!state.savedVoiceChannelId) return message.reply("❌ لازم تكتب `!ادخل ID` أول.");

      const guild = streamer.client.guilds.cache.get(state.savedGuildId);
      const voiceChannel = guild?.channels.cache.get(state.savedVoiceChannelId);
      if (!voiceChannel) return message.reply("❌ ما قدرت أوصل للقناة.");

      const isYT = isYoutubeUrl(rawUrl);
      await message.reply(`⏳ جاري التشغيل...${isYT ? " (يوتيوب - انتظر 10-15 ثانية)" : ""}`);

      const videoUrl = await resolveVideoUrl(rawUrl);
      const displayName = isYT ? rawUrl : (rawUrl.split("/").pop().split("?")[0] || "فيديو");
      await startPlayback(voiceChannel, message.channel, videoUrl, null, 0, displayName);

    // ===== !ايقاف =====
    } else if (cmd === "ايقاف") {
      await stopPlayback(message.channel);
      state.savedVoiceChannelId = null;
      state.savedGuildId = null;
      message.reply("⏹️ تم الإيقاف والخروج.");

    // ===== !مساعدة =====
    } else if (cmd === "مساعدة") {
      message.reply([
        "**🎬 أوامر بوت السينيما:**",
        "",
        "`!ادخل ID` — يدخل قناة الصوت",
        "`!كام` — يفتح الكاميرا",
        "`!تشغيل رابط` — يشغل فيديو (رابط mp4 أو يوتيوب)",
        "`!ايقاف` — يوقف التشغيل ويخرج",
        "",
        "**أزرار لوحة التحكم:**",
        "⏪ 10 — يرجع 10 ثواني",
        "⏸️ إيقاف مؤقت / ▶️ استمرار",
        "⏩ 10 — يتقدم 10 ثواني",
        "⏹️ إيقاف نهائي",
      ].join("\n"));
    }

  } catch (err) {
    console.error(err);
    message.reply("❌ حدث خطأ: " + err.message).catch(() => {});
  }
});

streamer.client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton || !interaction.isButton()) return;
  if (interaction.user.id !== OWNER_ID) return;

  try {
    if (interaction.customId === "toggle_pause") {
      if (!state.ffmpegProc) return;
      if (state.isPaused) {
        state.ffmpegProc.kill("SIGCONT");
        state.totalPausedMs += Date.now() - state.pausedAt;
        state.isPaused = false;
      } else {
        state.ffmpegProc.kill("SIGSTOP");
        state.pausedAt = Date.now();
        state.isPaused = true;
      }
      await sendOrUpdateControlPanel(interaction.channel);
    } else if (interaction.customId === "back10" || interaction.customId === "fwd10") {
      const delta = interaction.customId === "back10" ? -10 : 10;
      const newSeek = Math.max(0, elapsedSeconds() + delta);
      const { videoUrl, subtitlePath, voiceChannel, currentName } = state;
      if (!videoUrl || !voiceChannel) return;
      await startPlayback(voiceChannel, interaction.channel, videoUrl, subtitlePath, newSeek, currentName);
    } else if (interaction.customId === "stop_btn") {
      await stopPlayback(interaction.channel);
    }
  } catch (err) {
    console.error("❌ خطأ بمعالجة الزر:", err.message);
  }
});

streamer.client.login(process.env.DISCORD_TOKEN);
