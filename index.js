const { Client, GatewayIntentBits, EmbedBuilder, ActivityType, ChannelType } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, entersState, VoiceConnectionStatus, AudioPlayerStatus } = require('@discordjs/voice');
const ytdl = require('ytdl-core');
const ytSearch = require('yt-search');
const SpotifyWebApi = require('spotify-web-api-node');
const fs = require('fs');
const path = require('path');

// Discord Client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ]
});

// Spotify API
const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET
});

// Music queues
const queues = new Map();
const audioPlayers = new Map();

// Initialize Spotify
async function initSpotify() {
  try {
    const data = await spotifyApi.clientCredentialsGrant();
    spotifyApi.setAccessToken(data.body['access_token']);
    console.log('✅ Spotify API connected');
  } catch (error) {
    console.log('❌ Spotify API error (optional)');
  }
}

// Get queue for guild
function getQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, []);
  }
  return queues.get(guildId);
}

// Search YouTube
async function searchYouTube(query) {
  try {
    const searchResult = await ytSearch(query);
    return searchResult.videos.slice(0, 5);
  } catch (error) {
    console.error('YouTube search error:', error);
    return [];
  }
}

// Get YouTube track info
async function getYouTubeTrackInfo(url) {
  try {
    const info = await ytdl.getInfo(url);
    return {
      title: info.videoDetails.title,
      duration: formatDuration(info.videoDetails.lengthSeconds),
      thumbnail: info.videoDetails.thumbnails[0].url,
      url: url,
      type: 'youtube'
    };
  } catch (error) {
    throw new Error('Failed to get YouTube track info');
  }
}

// Get Spotify track info and find YouTube equivalent
async function getSpotifyTrackInfo(url) {
  try {
    const trackId = url.split('/track/')[1]?.split('?')[0];
    if (!trackId) throw new Error('Invalid Spotify URL');

    const track = await spotifyApi.getTrack(trackId);
    const artists = track.body.artists.map(artist => artist.name).join(', ');
    
    // Search on YouTube
    const searchQuery = `${track.body.name} ${artists} audio`;
    const ytResults = await searchYouTube(searchQuery);
    
    if (ytResults.length === 0) {
      throw new Error('Track not found on YouTube');
    }

    return {
      title: track.body.name,
      artist: artists,
      duration: formatDuration(Math.floor(track.body.duration_ms / 1000)),
      thumbnail: track.body.album.images[0]?.url,
      youtubeUrl: ytResults[0].url,
      spotifyUrl: url,
      type: 'spotify'
    };
  } catch (error) {
    throw new Error('Failed to process Spotify track');
  }
}

// Format duration
function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

// Play music in voice channel
async function playMusic(guildId, voiceChannel, textChannel, trackInfo) {
  try {
    const queue = getQueue(guildId);
    queue.push({ ...trackInfo, textChannel });
    
    // Create voice connection
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });

    // Create audio player
    const player = createAudioPlayer();
    audioPlayers.set(guildId, player);

    connection.subscribe(player);

    // Send now playing embed
    const embed = new EmbedBuilder()
      .setTitle('🎵 Now Playing')
      .setDescription(`**${trackInfo.title}**`)
      .addFields(
        { name: '🎤 Artist', value: trackInfo.artist || 'Unknown', inline: true },
        { name: '⏱️ Duration', value: trackInfo.duration, inline: true },
        { name: '🔗 Source', value: trackInfo.type === 'spotify' ? 'Spotify' : 'YouTube', inline: true }
      )
      .setThumbnail(trackInfo.thumbnail)
      .setColor(0x00FF00);

    await textChannel.send({ embeds: [embed] });

    // Play audio
    const stream = ytdl(trackInfo.type === 'spotify' ? trackInfo.youtubeUrl : trackInfo.url, {
      filter: 'audioonly',
      quality: 'highestaudio',
      highWaterMark: 1 << 25
    });

    const resource = createAudioResource(stream);
    player.play(resource);

    // Handle track end
    player.on(AudioPlayerStatus.Idle, () => {
      queue.shift();
      if (queue.length > 0) {
        playMusic(guildId, voiceChannel, textChannel, queue[0]);
      } else {
        connection.destroy();
        audioPlayers.delete(guildId);
      }
    });

    player.on('error', error => {
      console.error('Audio player error:', error);
      textChannel.send('❌ Error playing audio. Skipping to next track.');
      queue.shift();
      if (queue.length > 0) {
        playMusic(guildId, voiceChannel, textChannel, queue[0]);
      }
    });

  } catch (error) {
    console.error('Play music error:', error);
    textChannel.send('❌ Failed to play music. Please try again.');
  }
}

// Bot ready event
client.once('ready', () => {
  console.log(`🎵 ${client.user.tag} is online!`);
  client.user.setActivity('music | /play', { type: ActivityType.Listening });
  initSpotify();
});

// Message commands
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const prefix = '!';
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // Play command
  if (command === 'play' || command === 'p') {
    const query = args.join(' ');
    if (!query) {
      return message.reply('❌ Please provide a song name or URL. Example: `!play coldplay adventure`');
    }

    if (!message.member.voice.channel) {
      return message.reply('❌ You need to join a voice channel first!');
    }

    try {
      let trackInfo;

      // YouTube URL
      if (query.includes('youtube.com/') || query.includes('youtu.be/')) {
        trackInfo = await getYouTubeTrackInfo(query);
      }
      // Spotify URL
      else if (query.includes('spotify.com/track/')) {
        trackInfo = await getSpotifyTrackInfo(query);
      }
      // Search query
      else {
        await message.reply(`🔍 Searching: "${query}"...`);
        const results = await searchYouTube(query + ' audio');
        
        if (results.length === 0) {
          return message.reply('❌ No results found. Try a different search.');
        }

        trackInfo = {
          title: results[0].title,
          artist: results[0].author?.name || 'Unknown',
          duration: results[0].timestamp,
          thumbnail: results[0].thumbnail,
          url: results[0].url,
          type: 'youtube'
        };
      }

      const queue = getQueue(message.guild.id);
      const isFirstInQueue = queue.length === 0;

      // Add to queue message
      const queueEmbed = new EmbedBuilder()
        .setTitle('📥 Added to Queue')
        .setDescription(`**${trackInfo.title}**`)
        .addFields(
          { name: '🎤 Artist', value: trackInfo.artist || 'Unknown', inline: true },
          { name: '⏱️ Duration', value: trackInfo.duration, inline: true },
          { name: '🎯 Position', value: isFirstInQueue ? 'Now Playing' : `#${queue.length + 1}`, inline: true }
        )
        .setThumbnail(trackInfo.thumbnail)
        .setColor(0x0099FF);

      await message.reply({ embeds: [queueEmbed] });

      // Start playing if first in queue
      if (isFirstInQueue) {
        await playMusic(message.guild.id, message.member.voice.channel, message.channel, trackInfo);
      } else {
        queue.push(trackInfo);
      }

    } catch (error) {
      console.error('Play command error:', error);
      message.reply('❌ Failed to play music. Please try again.');
    }
  }

  // Skip command
  if (command === 'skip') {
    const queue = getQueue(message.guild.id);
    const player = audioPlayers.get(message.guild.id);

    if (!player || queue.length === 0) {
      return message.reply('❌ No music is currently playing.');
    }

    player.stop();
    message.reply('⏭️ Skipped to next track.');
  }

  // Queue command
  if (command === 'queue' || command === 'q') {
    const queue = getQueue(message.guild.id);

    if (queue.length === 0) {
      return message.reply('📭 Queue is empty. Use `!play [song]` to add music.');
    }

    const queueText = queue.slice(0, 10).map((track, index) => {
      return `${index + 1}. **${track.title}** - ${track.artist || 'Unknown'}`;
    }).join('\n');

    const embed = new EmbedBuilder()
      .setTitle('📊 Music Queue')
      .setDescription(queueText)
      .setColor(0xFFA500)
      .setFooter({ text: `Total tracks: ${queue.length}` });

    message.reply({ embeds: [embed] });
  }

  // Now playing command
  if (command === 'nowplaying' || command === 'np') {
    const queue = getQueue(message.guild.id);
    
    if (queue.length === 0) {
      return message.reply('❌ No music is currently playing.');
    }

    const currentTrack = queue[0];
    const embed = new EmbedBuilder()
      .setTitle('🎶 Now Playing')
      .setDescription(`**${currentTrack.title}**`)
      .addFields(
        { name: '🎤 Artist', value: currentTrack.artist || 'Unknown', inline: true },
        { name: '⏱️ Duration', value: currentTrack.duration, inline: true },
        { name: '🔗 Source', value: currentTrack.type === 'spotify' ? 'Spotify' : 'YouTube', inline: true }
      )
      .setThumbnail(currentTrack.thumbnail)
      .setColor(0x00FF00);

    message.reply({ embeds: [embed] });
  }

  // Stop command
  if (command === 'stop') {
    const queue = getQueue(message.guild.id);
    const player = audioPlayers.get(message.guild.id);

    if (!player) {
      return message.reply('❌ No music is currently playing.');
    }

    queue.length = 0;
    player.stop();
    message.reply('⏹️ Stopped playback and cleared queue.');
  }

  // Help command
  if (command === 'help') {
    const embed = new EmbedBuilder()
      .setTitle('🎵 Music Bot Help')
      .setDescription('Commands for the music bot:')
      .addFields(
        { name: '!play [song/URL]', value: 'Play music from YouTube or Spotify', inline: true },
        { name: '!skip', value: 'Skip current track', inline: true },
        { name: '!queue', value: 'Show music queue', inline: true },
        { name: '!nowplaying', value: 'Current track info', inline: true },
        { name: '!stop', value: 'Stop playback', inline: true },
        { name: '!help', value: 'Show this help message', inline: true }
      )
      .setColor(0x7289DA);

    message.reply({ embeds: [embed] });
  }
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN);