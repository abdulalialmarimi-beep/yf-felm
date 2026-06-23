import { Client, MessageActionRow, MessageButton } from "discord.js-selfbot-v13";
import { Streamer, prepareStream, playStream, Utils } from "@dank074/discord-video-stream";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import http from "http";

dotenv.config();

// سيرفر HTTP وهمي - بعض منصات الاستضافة (مثل Render) تتوقع منفذ مفتوح
// حتى لو البوت ما يحتاج فعلياً يستقبل طلبات HTTP
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("بوت السينيما شغال ✅");
  })
  .listen(PORT, () => console.log(`🌐 سيرفر وهمي شغال على منفذ ${PORT}`));

const PREFIX = process.env.PREFIX || "!";
const OWNER_ID = process.env.OWNER_ID;
const LIBRARY_PATH = path.join(process.cwd(), "library.json");
const TMP_DIR = "/tmp";

const streamer = new Streamer(new Client());

// ---------- حالة التشغيل الحالية ----------
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
};

function loadLibrary() {
  try {
    const raw = fs.readFileSync(LIBRARY_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("❌ ما قدرت أقرأ library.json:", e.message);
    return {};
  }
}

function findInLibrary(query) {
  const lib = loadLibrary();
  const q = query.trim().toLowerCase();
  const keys = Object.keys(lib);
  let key = keys.find((k) => k.toLowerCase() === q);
  if (!key) key = keys.find((k) => k.toLowerCase().includes(q));
  return key ? { name: key, ...lib[key] } : null;
}

async function downloadSubtitle(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("فشل تحميل ملف الترجمة: " + res.status);
    const text = await res.text();
    const filePath = path.join(TMP_DIR, `sub_${Date.now()}.srt`);
    fs.writeFileSync(filePath, text);
    return filePath;
  } catch (e) {
    console.error("❌ خطأ بتحميل الترجمة:", e.message);
    return null;
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
  };

  const customFlags = [];
  if (seekSeconds > 0) {
    customFlags.push("-ss", String(seekSeconds));
  }
  if (subtitlePath) {
    const escaped = subtitlePath.replace(/\\/g, "/").replace(/:/g, "\\:");
    customFlags.push("-vf", `scale=-2:720,subtitles='${escaped}'`);
  } else {
    ffmpegOptions.height = 720;
  }
  if (customFlags.length) ffmpegOptions.customFfmpegFlags = customFlags;

  const { command, output } = prepareStream(videoUrl, ffmpegOptions);

  command.on("start", () => {
    state.ffmpegProc = command.ffmpegProc || null;
  });

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

  playStream(output, streamer, { type: "go-live" })
    .then(() => {
      console.log("✅ انتهى تشغيل الفيديو");
      state.isStreaming = false;
    })
    .catch((err) => {
      console.error("❌ خطأ أثناء التشغيل:", err.message);
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
  await streamer.leaveVoice();
  if (state.controlMessage) {
    try {
      await state.controlMessage.edit({ content: "⏹️ تم إيقاف التشغيل.", components: [] });
    } catch {}
  }
  state.controlMessage = null;
  state.currentName = null;
}

streamer.client.on("ready", () => {
  console.log(`✅ تم تسجيل الدخول بنجاح كـ ${streamer.client.user.tag}`);
});

streamer.client.on("messageCreate", async (message) => {
  console.log(`📩 رسالة وصلت من: ${message.author?.tag} (${message.author?.id}) | المحتوى: "${message.content}" | القناة: ${message.channel?.id}`);
  if (!OWNER_ID || message.author.id !== OWNER_ID) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const cmd = args.shift().toLowerCase();

  try {
    if (cmd === "تشغيل") {
      const query = args.join(" ");
      if (!query) return message.reply("اكتب اسم الفيلم/المسلسل بعد الأمر. مثال: `" + PREFIX + "تشغيل فروزن`");

      const item = findInLibrary(query);
      if (!item) return message.reply("❌ ما لقيت هذا الاسم بالقائمة. استخدم `" + PREFIX + "قائمة` لعرض المتوفر.");

      const voiceChannel = message.member?.voice?.channel;
      if (!voiceChannel) return message.reply("لازم تكون داخل Voice Channel.");

      await message.reply(`⏳ جاري تجهيز: **${item.name}**...`);

      let subtitlePath = null;
      if (item.subtitle) {
        subtitlePath = await downloadSubtitle(item.subtitle);
      }

      await startPlayback(voiceChannel, message.channel, item.video, subtitlePath, 0, item.name);
    } else if (cmd === "قائمة") {
      const lib = loadLibrary();
      const names = Object.keys(lib);
      if (!names.length) return message.reply("القائمة فاضية. ضيف أفلام بملف library.json");
      message.reply("📋 **المتوفر:**\n" + names.map((n) => `• ${n}`).join("\n"));
    } else if (cmd === "ايقاف") {
      await stopPlayback(message.channel);
      message.reply("⏹️ تم الإيقاف والخروج.");
    } else if (cmd === "مساعدة") {
      message.reply(
        [
          "**🎬 أوامر بوت السينيما:**",
          `\`${PREFIX}تشغيل <اسم>\` — تشغيل فيلم/مسلسل من القائمة`,
          `\`${PREFIX}قائمة\` — عرض الأفلام المتوفرة`,
          `\`${PREFIX}ايقاف\` — إيقاف التشغيل والخروج`,
        ].join("\n")
      );
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
