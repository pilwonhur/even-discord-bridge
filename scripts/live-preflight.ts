// G0 live readiness check. READ-ONLY: GET requests only, no Gateway connection, no posts.
// Prints identities/names so the owner can confirm the IDs; never prints the token.
//   DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... DISCORD_CHANNEL_ID=... DISCORD_RELAY_BOT_ID=... DISCORD_CHRIS_BOT_ID=... node scripts/live-preflight.ts
import { RealDiscord } from '../src/discord/real.ts';
import { createLogger } from '../src/log.ts';

const env = process.env;
const token = env.DISCORD_BOT_TOKEN ?? '';
const ids = {
  guildId: env.DISCORD_GUILD_ID ?? '',
  channelId: env.DISCORD_CHANNEL_ID ?? '',
  relayBotId: env.DISCORD_RELAY_BOT_ID ?? '',
  chrisBotId: env.DISCORD_CHRIS_BOT_ID ?? '',
};
if (!token) {
  process.stderr.write('DISCORD_BOT_TOKEN missing\n');
  process.exit(2);
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    headers: { authorization: `Bot ${token}`, 'user-agent': 'DiscordBot (https://example.invalid/even-discord-bridge, 0.1.0)' },
    signal: AbortSignal.timeout(15_000),
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body };
}

const out: Record<string, unknown> = { mode: 'read-only preflight (no posts, no gateway)', at: new Date().toISOString(), ids };
const me = await get('/users/@me');
out.relay_bot = me.status === 200 ? { id: me.body.id, username: me.body.username, bot: me.body.bot, matches_config: me.body.id === ids.relayBotId } : { http: me.status };
const guilds = await get('/users/@me/guilds');
out.relay_bot_in_guild = guilds.status === 200 ? (guilds.body as { id: string }[]).some((g) => g.id === ids.guildId) : { http: guilds.status };
out.relay_bot_guild_count = guilds.status === 200 ? guilds.body.length : null;
const ch = await get(`/channels/${ids.channelId}`);
out.channel = ch.status === 200 ? { id: ch.body.id, name: ch.body.name, type: ch.body.type, guild_id: ch.body.guild_id } : { http: ch.status };
const chris = await get(`/users/${ids.chrisBotId}`);
out.chris_user = chris.status === 200 ? { id: chris.body.id, username: chris.body.username, global_name: chris.body.global_name, bot: chris.body.bot } : { http: chris.status };

const adapter = new RealDiscord({ token, ...ids, logger: createLogger([token], () => {}) });
out.readiness = await adapter.checkReadiness();
process.stdout.write(JSON.stringify(out, null, 2).split(token).join('[REDACTED]') + '\n');
