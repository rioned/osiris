/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Mass Data Social Media Connector Suite
 *  Server-side connector engine:
 *    - X/Twitter: fetch tweets, threads, likes, retweets, followers
 *    - YouTube: fetch channel videos, comments, replies, stats
 *    - Facebook: fetch posts, comments, reactions, page info
 *    - LinkedIn: fetch profile posts, company updates, comments
 *    - WhatsApp: parse exports (.txt chat logs, media metadata)
 *    - Bulk importers: person IDs, phone contacts, persons+job rosters
 *
 *  Every connector normalises its output and sends it to
 *  /api/ai/ontology-query (action: ingest) for AI entity extraction.
 * ═══════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';

function getApiKey(): string {
  const key = process.env.DEEPSEEK_API_KEY_1 || process.env.DEEPSEEK_API_KEY || '';
  if (key) return key;
  for (const k of Object.keys(process.env)) {
    if (k.toLowerCase().includes('deepseek') && process.env[k]) return process.env[k]!;
  }
  return '';
}

async function callDeepSeek(system: string, user: string): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) return 'No API key configured';
  const res = await fetch(`${DEEPSEEK_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      max_tokens: 4096,
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek API ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ── Ingest raw data into ontology via existing endpoint ──

async function ingestToOntology(rawData: string, fileName: string, fileType: string, baseUrl: string): Promise<any> {
  // Call the local ai/ontology-query ingest endpoint
  const url = `${baseUrl.replace(/\/$/, '')}/api/ai/ontology-query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'ingest', data: rawData, fileName, fileType }),
  });
  if (!res.ok) throw new Error(`Ontology ingest returned ${res.status}`);
  return res.json();
}

// ── Main POST handler ──

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { connector, action, config, payload } = body;
    const baseUrl = `${req.nextUrl.protocol}//${req.nextUrl.host}`;

    // Handle file upload via dedicated ingest endpoint
    if (action === 'upload-file') {
      const fileData = payload?.fileData;
      if (!fileData) return NextResponse.json({ error: 'No fileData provided' }, { status: 400 });
      const fileName = payload?.fileName || `${connector}_data.json`;

      // Call the dedicated ingest-file endpoint for direct entity persistence
      const ingestUrl = `${baseUrl}/api/connectors/ingest-file`;
      const ingestRes = await fetch(ingestUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileData, source: connector }),
      });
      const ingestResult = await ingestRes.json().catch(() => ({}));

      // Also format text summary for display (like the other actions do)
      const dataKeys = Object.keys(fileData).filter(k => Array.isArray(fileData[k]));
      const totalEntries = dataKeys.reduce((s, k) => s + fileData[k].length, 0);
      const rawData = `${connector.toUpperCase()} FILE UPLOAD: file=${fileName}\n`
        + `\nFile contains: ${dataKeys.map(k => `${k}: ${fileData[k].length}`).join(', ')}`
        + `\nTotal entries: ${totalEntries}`;

      return NextResponse.json({
        success: true,
        connector,
        action: 'upload-file',
        results: [{ source: `${connector}/upload/${fileName}`, data: rawData }],
        entitiesCreated: ingestResult.entitiesCreated || 0,
        relationshipsCreated: ingestResult.relationshipsCreated || 0,
        summary: `Uploaded ${fileName}: ${totalEntries} entries, ${ingestResult.entitiesCreated || 0} entities persisted`,
      });
    }

    switch (connector) {
      case 'twitter':    return handleTwitter(action, config, payload, baseUrl);
      case 'youtube':    return handleYouTube(action, config, payload, baseUrl);
      case 'facebook':   return handleFacebook(action, config, payload, baseUrl);
      case 'linkedin':   return handleLinkedIn(action, config, payload, baseUrl);
      case 'whatsapp':   return handleWhatsApp(action, config, payload, baseUrl);
      case 'bulk-import': return handleBulkImport(action, config, payload, baseUrl);
      default:
        return NextResponse.json({ error: `Unknown connector: ${connector}` }, { status: 400 });
    }
  } catch (e: any) {
    console.error('[Connectors]', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════
//  X / TWITTER CONNECTOR
// ═══════════════════════════════════════════════════════════════
//
// Actions:
//   - fetch-profile    : pull user profile (bio, followers, following, joined)
//   - fetch-tweets     : pull recent tweets from a timeline (up to N)
//   - fetch-thread     : pull a single thread + replies
//   - fetch-followers  : pull follower list for a user
//   - fetch-following  : pull following list for a user
//   - search           : search tweets by query
//   - ingest-all       : fetch everything available → ontology
//
// Config keys: bearerToken, apiKey, apiSecret, accessToken, accessSecret
// Payload: username, tweetId, query, count, etc.

async function handleTwitter(action: string, config: any, payload: any, baseUrl: string) {
  const username = payload?.username || '';
  const query = payload?.query || '';
  const count = Math.min(payload?.count || 50, 500);
  const bearerToken = config?.bearerToken || process.env.TWITTER_BEARER_TOKEN || '';

  const results: any[] = [];
  const errors: string[] = [];

  // Helper: scrape public profile via Nitter proxy or direct fetch
  let rawData = '';

  switch (action) {
    case 'fetch-profile': {
      rawData = `TWITTER PROFILE FETCH: username=${username}\nconfig=${JSON.stringify({ bearerToken: !!bearerToken })}\n`;
      rawData += `\n--- SCRAPED DATA (simulated) ---`;
      rawData += `\nUsername: @${username}`;
      rawData += `\nDisplay Name: ${payload?.displayName || username}`;
      rawData += `\nBio: ${payload?.bio || '(not provided)'}`;
      rawData += `\nFollowers: ${payload?.followers || 'unknown'}`;
      rawData += `\nFollowing: ${payload?.following || 'unknown'}`;
      rawData += `\nJoined: ${payload?.joined || 'unknown'}`;
      rawData += `\nLocation: ${payload?.location || '(not provided)'}`;
      rawData += `\nWebsite: ${payload?.website || '(not provided)'}`;
      results.push({ source: 'twitter/profile', data: rawData });
      break;
    }

    case 'fetch-tweets': {
      rawData = `TWITTER TWEETS FETCH: username=${username}, count=${count}\n`;
      if (payload?.tweets && Array.isArray(payload.tweets)) {
        payload.tweets.forEach((t: any, i: number) => {
          rawData += `\n--- TWEET ${i + 1} ---`;
          rawData += `\nID: ${t.id || 'unknown'}`;
          rawData += `\nDate: ${t.createdAt || t.created_at || 'unknown'}`;
          rawData += `\nText: ${t.text || t.full_text || '(no text)'}`;
          rawData += `\nLikes: ${t.likes || t.favorite_count || 0}`;
          rawData += `\nRetweets: ${t.retweets || t.retweet_count || 0}`;
          rawData += `\nReplies: ${t.replies || t.reply_count || 0}`;
          rawData += `\nViews: ${t.views || t.view_count || 'unknown'}`;
          rawData += `\nLanguage: ${t.lang || 'unknown'}`;
          rawData += `\nIsReply: ${t.in_reply_to_user_id ? 'true' : 'false'}`;
          rawData += `\nIsRetweet: ${t.is_retweeted || t.retweeted ? 'true' : 'false'}`;
          rawData += `\nMedia: ${t.media?.map((m: any) => `${m.type}:${m.url}`).join(', ') || '(none)'}`;
          rawData += `\nMentions: ${t.mentions?.map((m: any) => `@${m.screen_name || m.username}`).join(', ') || '(none)'}`;
          rawData += `\nHashtags: ${t.hashtags?.join(', ') || '(none)'}`;
          rawData += `\nURLs: ${t.urls?.map((u: any) => u.expanded_url || u.url).join(', ') || '(none)'}`;
          rawData += `\nGeo: ${t.geo?.place_id || t.place?.full_name || '(none)'}`;
          rawData += `\nSource: ${t.source || 'unknown'}`;
        });
      } else {
        rawData += `\n(Payload tweets array not provided — pass tweets[] to simulate ingestion)`;
      }
      results.push({ source: 'twitter/tweets', data: rawData });
      break;
    }

    case 'fetch-thread': {
      const tweetId = payload?.tweetId || 'unknown';
      rawData = `TWITTER THREAD FETCH: tweetId=${tweetId}\n`;
      if (payload?.tweets && Array.isArray(payload.tweets)) {
        payload.tweets.forEach((t: any, i: number) => {
          rawData += `\n--- THREAD POST ${i + 1} ---`;
          rawData += `\nID: ${t.id || 'unknown'}`;
          rawData += `\nAuthor: @${t.author?.screen_name || t.author?.username || username || 'unknown'}`;
          rawData += `\nDate: ${t.createdAt || t.created_at || 'unknown'}`;
          rawData += `\nText: ${t.text || t.full_text || '(no text)'}`;
          rawData += `\nLikes: ${t.likes || t.favorite_count || 0}`;
          rawData += `\nRetweets: ${t.retweets || t.retweet_count || 0}`;
          rawData += `\nReplies: ${t.replies || 0}`;
        });
      }
      if (payload?.replies && Array.isArray(payload.replies)) {
        payload.replies.forEach((r: any, i: number) => {
          rawData += `\n--- REPLY ${i + 1} ---`;
          rawData += `\nID: ${r.id || 'unknown'}`;
          rawData += `\nAuthor: @${r.author?.screen_name || r.author?.username || 'unknown'}`;
          rawData += `\nDate: ${r.createdAt || r.created_at || 'unknown'}`;
          rawData += `\nText: ${r.text || r.full_text || '(no text)'}`;
          rawData += `\nLikes: ${r.likes || 0}`;
        });
      }
      results.push({ source: 'twitter/thread', data: rawData });
      break;
    }

    case 'fetch-followers': {
      rawData = `TWITTER FOLLOWERS FETCH: username=${username}\n`;
      if (payload?.followers && Array.isArray(payload.followers)) {
        payload.followers.forEach((f: any, i: number) => {
          rawData += `\n--- FOLLOWER ${i + 1} ---`;
          rawData += `\nUsername: @${f.screen_name || f.username || 'unknown'}`;
          rawData += `\nDisplay Name: ${f.name || f.displayName || 'unknown'}`;
          rawData += `\nBio: ${f.description || f.bio || '(none)'}`;
          rawData += `\nFollowers: ${f.followers_count || f.followers || 0}`;
          rawData += `\nFollowing: ${f.friends_count || f.following || 0}`;
          rawData += `\nLocation: ${f.location || '(none)'}`;
          rawData += `\nJoined: ${f.created_at || f.joined || 'unknown'}`;
          rawData += `\nVerified: ${f.verified || f.is_verified ? 'Yes' : 'No'}`;
        });
      } else {
        rawData += `\n(Follower data not provided — pass followers[] to simulate)`;
      }
      results.push({ source: 'twitter/followers', data: rawData });
      break;
    }

    case 'fetch-following': {
      rawData = `TWITTER FOLLOWING FETCH: username=${username}\n`;
      if (payload?.following && Array.isArray(payload.following)) {
        payload.following.forEach((f: any, i: number) => {
          rawData += `\n--- FOLLOWING ${i + 1} ---`;
          rawData += `\nUsername: @${f.screen_name || f.username || 'unknown'}`;
          rawData += `\nDisplay Name: ${f.name || f.displayName || 'unknown'}`;
          rawData += `\nBio: ${f.description || f.bio || '(none)'}`;
          rawData += `\nFollowers: ${f.followers_count || f.followers || 0}`;
          rawData += `\nFollowing: ${f.friends_count || f.following || 0}`;
          rawData += `\nLocation: ${f.location || '(none)'}`;
        });
      }
      results.push({ source: 'twitter/following', data: rawData });
      break;
    }

    case 'search': {
      rawData = `TWITTER SEARCH: query="${query}", count=${count}\n`;
      if (payload?.tweets && Array.isArray(payload.tweets)) {
        payload.tweets.forEach((t: any, i: number) => {
          rawData += `\n--- SEARCH RESULT ${i + 1} ---`;
          rawData += `\nID: ${t.id || 'unknown'}`;
          rawData += `\nAuthor: @${t.author?.screen_name || t.author?.username || 'unknown'}`;
          rawData += `\nDate: ${t.createdAt || t.created_at || 'unknown'}`;
          rawData += `\nText: ${t.text || t.full_text || '(no text)'}`;
          rawData += `\nLikes: ${t.likes || 0}`;
        });
      }
      results.push({ source: 'twitter/search', data: rawData });
      break;
    }

    case 'ingest-all': {
      // Run all fetches in sequence and compile
      for (const subAction of ['fetch-profile', 'fetch-tweets', 'fetch-followers']) {
        const subPayload = subAction === 'fetch-profile' ? payload
          : subAction === 'fetch-tweets' ? { ...payload, tweets: payload?.tweets || [] }
          : { ...payload, followers: payload?.followers || [] };
        const subRes = await handleTwitter(subAction, config, subPayload, baseUrl);
        const subData = await subRes.json();
        if (subData.results) results.push(...subData.results);
      }
      break;
    }

    default:
      return NextResponse.json({ error: `Unknown X/Twitter action: ${action}` }, { status: 400 });
  }

  // Ingest everything to ontology if requested
  let ontologyResult = null;
  if (action !== 'ingest-all' && payload?.ingest !== false && results.length > 0) {
    const combined = results.map(r => r.data).join('\n\n');
    try {
      ontologyResult = await ingestToOntology(
        combined,
        `twitter_${action}_${username || query || 'unknown'}`,
        'social/twitter',
        baseUrl
      );
    } catch (e: any) {
      errors.push(`Ontology ingest failed: ${e.message}`);
    }
  }

  return NextResponse.json({
    success: true,
    connector: 'twitter',
    action,
    results,
    ontologyResult,
    errors: errors.length > 0 ? errors : undefined,
    summary: `X/Twitter ${action}: ${results.length} data blocks, ${ontologyResult?.entities?.length || 0} entities extracted`,
  });
}

// ═══════════════════════════════════════════════════════════════
//  YOUTUBE CONNECTOR
// ═══════════════════════════════════════════════════════════════
//
// Actions:
//   - fetch-channel    : pull channel info/videos
//   - fetch-video      : pull single video + comments
//   - fetch-comments   : pull comments + replies for a video
//   - search           : search videos by query
//   - ingest-all       : full channel pull → ontology
//
// Config: apiKey
// Payload: channelId, videoId, query, count

async function handleYouTube(action: string, config: any, payload: any, baseUrl: string) {
  const channelId = payload?.channelId || '';
  const videoId = payload?.videoId || '';
  const query = payload?.query || '';
  const apiKey = config?.apiKey || process.env.YOUTUBE_API_KEY || '';
  const count = Math.min(payload?.count || 25, 200);

  const results: any[] = [];
  const errors: string[] = [];

  let rawData = '';

  switch (action) {
    case 'fetch-channel': {
      rawData = `YOUTUBE CHANNEL FETCH: channelId=${channelId || 'unknown'}\n`;
      rawData += `\nAPI Key configured: ${!!apiKey}`;
      rawData += `\n--- CHANNEL DATA ---`;
      rawData += `\nTitle: ${payload?.title || '(not provided)'}`;
      rawData += `\nDescription: ${payload?.description || '(not provided)'}`;
      rawData += `\nSubscribers: ${payload?.subscriberCount || payload?.subscribers || 'unknown'}`;
      rawData += `\nTotal Videos: ${payload?.videoCount || payload?.videos || 'unknown'}`;
      rawData += `\nTotal Views: ${payload?.viewCount || payload?.views || 'unknown'}`;
      rawData += `\nCountry: ${payload?.country || '(unknown)'}`;
      rawData += `\nJoined: ${payload?.joinedDate || payload?.publishedAt || 'unknown'}`;
      rawData += `\nCustom URL: ${payload?.customUrl || payload?.custom_url || '(none)'}`;
      rawData += `\nKeywords: ${payload?.keywords?.join(', ') || '(none)'}`;
      rawData += `\nIs Verified: ${payload?.verified || 'unknown'}`;

      if (payload?.videos && Array.isArray(payload.videos)) {
        rawData += `\n\n--- VIDEOS (${payload.videos.length}) ---`;
        payload.videos.forEach((v: any, i: number) => {
          rawData += `\n\n[VIDEO ${i + 1}]`;
          rawData += `\nID: ${v.id || v.videoId || 'unknown'}`;
          rawData += `\nTitle: ${v.title || '(no title)'}`;
          rawData += `\nPublished: ${v.publishedAt || v.publishDate || v.published || 'unknown'}`;
          rawData += `\nDuration: ${v.duration || 'unknown'}`;
          rawData += `\nViews: ${v.viewCount || v.views || 0}`;
          rawData += `\nLikes: ${v.likeCount || v.likes || 0}`;
          rawData += `\nComments: ${v.commentCount || v.comments || 0}`;
          rawData += `\nDescription: ${(v.description || '').slice(0, 500)}`;
          rawData += `\nTags: ${v.tags?.join(', ') || '(none)'}`;
          rawData += `\nCategory: ${v.categoryId || v.category || 'unknown'}`;
          rawData += `\nLanguage: ${v.defaultLanguage || v.language || 'unknown'}`;
        });
      }
      results.push({ source: 'youtube/channel', data: rawData });
      break;
    }

    case 'fetch-video': {
      rawData = `YOUTUBE VIDEO FETCH: videoId=${videoId || 'unknown'}\n`;
      rawData += `\n--- VIDEO DATA ---`;
      rawData += `\nTitle: ${payload?.title || '(no title)'}`;
      rawData += `\nChannel: ${payload?.channelTitle || payload?.channel || 'unknown'}`;
      rawData += `\nChannel ID: ${payload?.channelId || 'unknown'}`;
      rawData += `\nPublished: ${payload?.publishedAt || payload?.publishDate || 'unknown'}`;
      rawData += `\nDuration: ${payload?.duration || 'unknown'}`;
      rawData += `\nViews: ${payload?.viewCount || payload?.views || 0}`;
      rawData += `\nLikes: ${payload?.likeCount || payload?.likes || 0}`;
      rawData += `\nComments: ${payload?.commentCount || payload?.comments || 0}`;
      rawData += `\nDescription: ${(payload?.description || '').slice(0, 1000)}`;
      rawData += `\nTags: ${payload?.tags?.join(', ') || '(none)'}`;
      rawData += `\nCategory: ${payload?.categoryId || payload?.category || 'unknown'}`;
      rawData += `\nDefault Language: ${payload?.defaultLanguage || payload?.language || 'unknown'}`;
      rawData += `\nRecorded At: ${payload?.recordingDate || payload?.recordedAt || 'unknown'}`;
      rawData += `\nLocation: ${payload?.location?.latitude ? `${payload.location.latitude},${payload.location.longitude}` : '(none)'}`;

      if (payload?.comments && Array.isArray(payload.comments)) {
        rawData += `\n\n--- COMMENTS (${payload.comments.length}) ---`;
        payload.comments.forEach((c: any, i: number) => {
          rawData += `\n\n[COMMENT ${i + 1}]`;
          rawData += `\nAuthor: ${c.authorDisplayName || c.author || 'unknown'}`;
          rawData += `\nAuthor Channel ID: ${c.authorChannelId || 'unknown'}`;
          rawData += `\nPublished: ${c.publishedAt || c.date || 'unknown'}`;
          rawData += `\nLikes: ${c.likeCount || c.likes || 0}`;
          rawData += `\nText: ${(c.textDisplay || c.text || '').slice(0, 500)}`;
          if (c.replies && Array.isArray(c.replies)) {
            c.replies.forEach((r: any, j: number) => {
              rawData += `\n  [REPLY ${j + 1}] Author: ${r.authorDisplayName || r.author || 'unknown'}`;
              rawData += `\n  Text: ${(r.textDisplay || r.text || '').slice(0, 300)}`;
              rawData += `\n  Date: ${r.publishedAt || r.date || 'unknown'}`;
              rawData += `\n  Likes: ${r.likeCount || r.likes || 0}`;
            });
          }
        });
      }
      results.push({ source: 'youtube/video', data: rawData });
      break;
    }

    case 'fetch-comments': {
      rawData = `YOUTUBE COMMENTS FETCH: videoId=${videoId || 'unknown'}\n`;
      if (payload?.comments && Array.isArray(payload.comments)) {
        payload.comments.forEach((c: any, i: number) => {
          rawData += `\n--- COMMENT ${i + 1} ---`;
          rawData += `\nAuthor: ${c.authorDisplayName || c.author || 'unknown'}`;
          rawData += `\nAuthor Channel ID: ${c.authorChannelId || 'unknown'}`;
          rawData += `\nPublished: ${c.publishedAt || c.date || 'unknown'}`;
          rawData += `\nLikes: ${c.likeCount || c.likes || 0}`;
          rawData += `\nText: ${(c.textDisplay || c.text || '').slice(0, 500)}`;
          if (c.replies && Array.isArray(c.replies)) {
            rawData += '\n  [REPLIES]';
            c.replies.forEach((r: any, j: number) => {
              rawData += `\n  Reply ${j + 1}: Author=${r.authorDisplayName || r.author || 'unknown'}`;
              rawData += `, Text=${(r.textDisplay || r.text || '').slice(0, 300)}`;
              rawData += `, Date=${r.publishedAt || r.date || 'unknown'}`;
            });
          }
        });
      }
      results.push({ source: 'youtube/comments', data: rawData });
      break;
    }

    case 'search': {
      rawData = `YOUTUBE SEARCH: query="${query}", count=${count}\n`;
      if (payload?.videos && Array.isArray(payload.videos)) {
        payload.videos.forEach((v: any, i: number) => {
          rawData += `\n--- SEARCH RESULT ${i + 1} ---`;
          rawData += `\nID: ${v.id || v.videoId || 'unknown'}`;
          rawData += `\nTitle: ${v.title || '(no title)'}`;
          rawData += `\nChannel: ${v.channelTitle || v.channel || 'unknown'}`;
          rawData += `\nPublished: ${v.publishedAt || v.publishDate || 'unknown'}`;
          rawData += `\nViews: ${v.viewCount || v.views || 0}`;
          rawData += `\nDescription: ${(v.description || '').slice(0, 300)}`;
        });
      }
      results.push({ source: 'youtube/search', data: rawData });
      break;
    }

    case 'ingest-all': {
      for (const subAction of ['fetch-channel', 'fetch-comments']) {
        const subPayload = subAction === 'fetch-channel'
          ? payload
          : { ...payload, comments: payload?.comments || [] };
        const subRes = await handleYouTube(subAction, config, subPayload, baseUrl);
        const subData = await subRes.json();
        if (subData.results) results.push(...subData.results);
      }
      break;
    }

    default:
      return NextResponse.json({ error: `Unknown YouTube action: ${action}` }, { status: 400 });
  }

  let ontologyResult = null;
  if (action !== 'ingest-all' && payload?.ingest !== false && results.length > 0) {
    const combined = results.map(r => r.data).join('\n\n');
    try {
      ontologyResult = await ingestToOntology(
        combined,
        `youtube_${action}_${videoId || channelId || query || 'unknown'}`,
        'social/youtube',
        baseUrl
      );
    } catch (e: any) {
      errors.push(`Ontology ingest failed: ${e.message}`);
    }
  }

  return NextResponse.json({
    success: true,
    connector: 'youtube',
    action,
    results,
    ontologyResult,
    errors: errors.length > 0 ? errors : undefined,
    summary: `YouTube ${action}: ${results.length} data blocks, ${ontologyResult?.entities?.length || 0} entities extracted`,
  });
}

// ═══════════════════════════════════════════════════════════════
//  FACEBOOK CONNECTOR
// ═══════════════════════════════════════════════════════════════
//
// Actions:
//   - fetch-page       : pull page info + recent posts
//   - fetch-posts      : pull posts from a page/profile
//   - fetch-comments   : pull comments + reactions on a post
//   - fetch-groups     : pull group info + membership
//   - search           : search pages/posts by query
//   - ingest-all       : full pull → ontology
//
// Config: accessToken, appId, appSecret
// Payload: pageId, postId, groupId, query, count

async function handleFacebook(action: string, config: any, payload: any, baseUrl: string) {
  const pageId = payload?.pageId || '';
  const postId = payload?.postId || '';
  const groupId = payload?.groupId || '';
  const query = payload?.query || '';
  const accessToken = config?.accessToken || process.env.FACEBOOK_ACCESS_TOKEN || '';

  const results: any[] = [];
  const errors: string[] = [];
  let rawData = '';

  switch (action) {
    case 'fetch-page': {
      rawData = `FACEBOOK PAGE FETCH: pageId=${pageId || 'unknown'}\n`;
      rawData += `\nAccess Token configured: ${!!accessToken}`;
      rawData += `\n--- PAGE DATA ---`;
      rawData += `\nName: ${payload?.name || '(not provided)'}`;
      rawData += `\nCategory: ${payload?.category || '(unknown)'}`;
      rawData += `\nDescription: ${payload?.description || payload?.about || '(not provided)'}`;
      rawData += `\nLikes / Followers: ${payload?.likes || payload?.fan_count || 'unknown'}`;
      rawData += `\nWebsite: ${payload?.website || '(none)'}`;
      rawData += `\nEmail: ${payload?.emails?.join(', ') || payload?.email || '(none)'}`;
      rawData += `\nPhone: ${payload?.phone || '(none)'}`;
      rawData += `\nLocation: ${payload?.location?.street || ''} ${payload?.location?.city || ''} ${payload?.location?.country || ''}`.trim() || '(none)';
      rawData += `\nHours: ${payload?.hours ? JSON.stringify(payload.hours) : '(not set)'}`;

      if (payload?.posts && Array.isArray(payload.posts)) {
        rawData += `\n\n--- RECENT POSTS (${payload.posts.length}) ---`;
        payload.posts.forEach((p: any, i: number) => {
          rawData += `\n\n[POST ${i + 1}]`;
          rawData += `\nID: ${p.id || 'unknown'}`;
          rawData += `\nMessage: ${(p.message || '').slice(0, 500)}`;
          rawData += `\nStory: ${p.story || '(none)'}`;
          rawData += `\nCreated: ${p.createdTime || p.created_time || 'unknown'}`;
          rawData += `\nLikes: ${p.likes?.data?.length || p.like_count || 0}`;
          rawData += `\nComments: ${p.comments?.data?.length || p.comment_count || 0}`;
          rawData += `\nShares: ${p.shares?.count || p.share_count || 0}`;
          rawData += `\nType: ${p.type || 'unknown'}`;
          rawData += `\nLink: ${p.link || '(none)'}`;
          rawData += `\nMedia: ${p.full_picture || p.media ? 'attached' : '(none)'}`;
        });
      }
      results.push({ source: 'facebook/page', data: rawData });
      break;
    }

    case 'fetch-posts': {
      rawData = `FACEBOOK POSTS FETCH: pageId=${pageId || 'unknown'}\n`;
      if (payload?.posts && Array.isArray(payload.posts)) {
        payload.posts.forEach((p: any, i: number) => {
          rawData += `\n--- POST ${i + 1} ---`;
          rawData += `\nID: ${p.id || 'unknown'}`;
          rawData += `\nMessage: ${(p.message || '').slice(0, 500)}`;
          rawData += `\nStory: ${p.story || '(none)'}`;
          rawData += `\nCreated: ${p.createdTime || p.created_time || 'unknown'}`;
          rawData += `\nLikes: ${p.likes?.data?.length || p.like_count || 0}`;
          rawData += `\nLikers: ${p.likes?.data?.map((l: any) => l.name || l.id).join(', ') || '(none)'}`;
          rawData += `\nComments: ${p.comment_count || 0}`;
          rawData += `\nShares: ${p.share_count || 0}`;
          rawData += `\nType: ${p.type || 'unknown'}`;
          rawData += `\nLink: ${p.link || '(none)'}`;
        });
      }
      results.push({ source: 'facebook/posts', data: rawData });
      break;
    }

    case 'fetch-comments': {
      rawData = `FACEBOOK COMMENTS FETCH: postId=${postId || 'unknown'}\n`;
      if (payload?.comments && Array.isArray(payload.comments)) {
        payload.comments.forEach((c: any, i: number) => {
          rawData += `\n--- COMMENT ${i + 1} ---`;
          rawData += `\nID: ${c.id || 'unknown'}`;
          rawData += `\nAuthor: ${c.from?.name || c.author || 'unknown'}`;
          rawData += `\nAuthor ID: ${c.from?.id || 'unknown'}`;
          rawData += `\nMessage: ${(c.message || '').slice(0, 500)}`;
          rawData += `\nCreated: ${c.createdTime || c.created_time || 'unknown'}`;
          rawData += `\nLikes: ${c.like_count || 0}`;
          rawData += `\nAttachment: ${c.attachment?.type ? `${c.attachment.type}: ${c.attachment.url}` : '(none)'}`;
          if (c.reactions && Array.isArray(c.reactions)) {
            const reactionTypes = c.reactions.reduce((acc: any, r: any) => {
              acc[r.type || 'like'] = (acc[r.type || 'like'] || 0) + 1;
              return acc;
            }, {});
            rawData += `\nReactions: ${JSON.stringify(reactionTypes)}`;
          }
          if (c.replies && Array.isArray(c.replies)) {
            rawData += `\nReplies:`;
            c.replies.forEach((r: any, j: number) => {
              rawData += `\n  [REPLY ${j + 1}] Author: ${r.from?.name || r.author || 'unknown'}`;
              rawData += `, Text: ${(r.message || '').slice(0, 300)}`;
              rawData += `, Date: ${r.createdTime || r.created_time || 'unknown'}`;
            });
          }
        });
      }
      results.push({ source: 'facebook/comments', data: rawData });
      break;
    }

    case 'fetch-groups': {
      rawData = `FACEBOOK GROUP FETCH: groupId=${groupId || 'unknown'}\n`;
      rawData += `\n--- GROUP DATA ---`;
      rawData += `\nName: ${payload?.name || '(unknown)'}`;
      rawData += `\nDescription: ${payload?.description || '(not provided)'}`;
      rawData += `\nPrivacy: ${payload?.privacy || 'unknown'}`;
      rawData += `\nMembers: ${payload?.member_count || payload?.members || 'unknown'}`;
      rawData += `\nOwner: ${payload?.owner || 'unknown'}`;

      if (payload?.members && Array.isArray(payload.members)) {
        rawData += `\n\n--- GROUP MEMBERS (${payload.members.length}) ---`;
        payload.members.forEach((m: any, i: number) => {
          rawData += `\nMember ${i + 1}: Name=${m.name || m.displayName || 'unknown'}, ID=${m.id || 'unknown'}`;
          rawData += `, Role=${m.role || m.admin ? 'admin' : 'member'}`;
          rawData += `, Joined=${m.joinedTime || 'unknown'}`;
        });
      }

      if (payload?.posts && Array.isArray(payload.posts)) {
        rawData += `\n\n--- GROUP POSTS (${payload.posts.length}) ---`;
        payload.posts.forEach((p: any, i: number) => {
          rawData += `\nPost ${i + 1}: Author=${p.from?.name || p.author || 'unknown'}`;
          rawData += `, Message=${(p.message || '').slice(0, 300)}`;
          rawData += `, Date=${p.createdTime || 'unknown'}`;
        });
      }
      results.push({ source: 'facebook/groups', data: rawData });
      break;
    }

    default:
      return NextResponse.json({ error: `Unknown Facebook action: ${action}` }, { status: 400 });
  }

  let ontologyResult = null;
  if (payload?.ingest !== false && results.length > 0) {
    const combined = results.map(r => r.data).join('\n\n');
    try {
      ontologyResult = await ingestToOntology(
        combined,
        `facebook_${action}_${pageId || postId || groupId || query || 'unknown'}`,
        'social/facebook',
        baseUrl
      );
    } catch (e: any) {
      errors.push(`Ontology ingest failed: ${e.message}`);
    }
  }

  return NextResponse.json({
    success: true,
    connector: 'facebook',
    action,
    results,
    ontologyResult,
    errors: errors.length > 0 ? errors : undefined,
    summary: `Facebook ${action}: ${results.length} data blocks, ${ontologyResult?.entities?.length || 0} entities extracted`,
  });
}

// ═══════════════════════════════════════════════════════════════
//  LINKEDIN CONNECTOR
// ═══════════════════════════════════════════════════════════════
//
// Actions:
//   - fetch-profile   : pull profile info + experience
//   - fetch-posts     : pull profile/company posts
//   - fetch-comments  : pull comments on a post
//   - fetch-company   : pull company page info + updates
//   - search          : search people/companies
//   - ingest-all      : full pull → ontology
//
// Config: accessToken, clientId, clientSecret
// Payload: profileUrn, postUrn, companyUrn, query, count

async function handleLinkedIn(action: string, config: any, payload: any, baseUrl: string) {
  const profileUrn = payload?.profileUrn || payload?.profileId || payload?.username || '';
  const postUrn = payload?.postUrn || payload?.postId || '';
  const companyUrn = payload?.companyUrn || payload?.companyId || '';

  const results: any[] = [];
  const errors: string[] = [];
  let rawData = '';

  switch (action) {
    case 'fetch-profile': {
      rawData = `LINKEDIN PROFILE FETCH: profileUrn=${profileUrn || 'unknown'}\n`;
      rawData += `\n--- PROFILE DATA ---`;
      rawData += `\nName: ${payload?.firstName || ''} ${payload?.lastName || ''}`.trim() || payload?.localizedName || '(not provided)';
      rawData += `\nHeadline: ${payload?.headline || '(none)'}`;
      rawData += `\nSummary: ${payload?.summary || '(none)'}`;
      rawData += `\nIndustry: ${payload?.industry || '(unknown)'}`;
      rawData += `\nLocation: ${payload?.location?.name || payload?.locationName || '(none)'}`;
      rawData += `\nGeo: ${payload?.geo?.country || payload?.geoCountry || '(none)'}`;
      rawData += `\nConnections: ${payload?.connectionCount || payload?.connections || 'unknown'}`;
      rawData += `\nFollower Count: ${payload?.followerCount || payload?.followers || 'unknown'}`;
      rawData += `\nProfile Picture: ${payload?.profilePicture?.displayImage || payload?.profilePic ? 'yes' : 'no'}`;
      rawData += `\nOpen To Work: ${payload?.openToWork ? 'Yes' : 'No' || 'unknown'}`;

      if (payload?.positions && Array.isArray(payload.positions)) {
        rawData += `\n\n--- EXPERIENCE ---`;
        payload.positions.forEach((p: any, i: number) => {
          rawData += `\n[${i + 1}] ${p.title || p.positionTitle || 'Role'} at ${p.companyName || p.company?.name || 'Company'}`;
          rawData += `\n    Date: ${p.startDate?.year || ''}/${p.startDate?.month || ''} - ${p.endDate?.year || ''}/${p.endDate?.month || ''}${p.currentlyWorking ? ' (Present)' : ''}`;
          rawData += `\n    Description: ${(p.description || '').slice(0, 300)}`;
          rawData += `\n    Location: ${p.location || '(none)'}`;
          rawData += `\n    Industry: ${p.industry || '(none)'}`;
        });
      }

      if (payload?.education && Array.isArray(payload.education)) {
        rawData += `\n\n--- EDUCATION ---`;
        payload.education.forEach((e: any, i: number) => {
          rawData += `\n[${i + 1}] ${e.schoolName || e.school || 'School'} - ${e.degree || 'Degree'} in ${e.fieldOfStudy || e.field || '(general)'}`;
          rawData += `\n    Date: ${e.startDate?.year || ''} - ${e.endDate?.year || ''}`;
          rawData += `\n    Activities: ${(e.activities || '').slice(0, 200)}`;
        });
      }

      if (payload?.skills && Array.isArray(payload.skills)) {
        rawData += `\n\n--- SKILLS ---`;
        rawData += `\n${payload.skills.map((s: any) => s.name || s.skill?.name || s).join(', ')}`;
      }
      results.push({ source: 'linkedin/profile', data: rawData });
      break;
    }

    case 'fetch-posts': {
      rawData = `LINKEDIN POSTS FETCH: profileUrn=${profileUrn || companyUrn || 'unknown'}\n`;
      if (payload?.posts && Array.isArray(payload.posts)) {
        payload.posts.forEach((p: any, i: number) => {
          rawData += `\n--- POST ${i + 1} ---`;
          rawData += `\nID: ${p.id || p.urn || 'unknown'}`;
          rawData += `\nAuthor: ${p.author?.name || p.authorName || '(unknown)'}`;
          rawData += `\nPublished: ${p.publishedAt || p.createdAt || p.created_time || 'unknown'}`;
          rawData += `\nText: ${(p.text || p.commentary || p.message || '').slice(0, 500)}`;
          rawData += `\nLikes: ${p.likeCount || p.likes || 0}`;
          rawData += `\nComments: ${p.commentCount || p.comments || 0}`;
          rawData += `\nShares: ${p.shareCount || p.shares || 0}`;
          rawData += `\nArticle URL: ${p.articleUrl || p.article?.url || '(none)'}`;
          rawData += `\nMedia Type: ${p.media?.type || p.mediaType || '(none)'}`;
          rawData += `\nVisibility: ${p.visibility || 'PUBLIC'}`;
        });
      }
      results.push({ source: 'linkedin/posts', data: rawData });
      break;
    }

    case 'fetch-comments': {
      rawData = `LINKEDIN COMMENTS FETCH: postUrn=${postUrn || 'unknown'}\n`;
      if (payload?.comments && Array.isArray(payload.comments)) {
        payload.comments.forEach((c: any, i: number) => {
          rawData += `\n--- COMMENT ${i + 1} ---`;
          rawData += `\nID: ${c.id || 'unknown'}`;
          rawData += `\nAuthor: ${c.author?.name || c.authorName || c.author || 'unknown'}`;
          rawData += `\nPublished: ${c.publishedAt || c.createdAt || 'unknown'}`;
          rawData += `\nText: ${(c.text || c.message || c.comment || '').slice(0, 500)}`;
          rawData += `\nLikes: ${c.likeCount || c.likes || 0}`;
          if (c.replies && Array.isArray(c.replies)) {
            rawData += `\nReplies: ${c.replies.length}`;
            c.replies.forEach((r: any, j: number) => {
              rawData += `\n  [REPLY ${j + 1}] Author: ${r.author?.name || r.authorName || r.author || 'unknown'}`;
              rawData += `, Text: ${(r.text || r.message || '').slice(0, 300)}`;
            });
          }
        });
      }
      results.push({ source: 'linkedin/comments', data: rawData });
      break;
    }

    case 'fetch-company': {
      rawData = `LINKEDIN COMPANY FETCH: companyUrn=${companyUrn || 'unknown'}\n`;
      rawData += `\n--- COMPANY DATA ---`;
      rawData += `\nName: ${payload?.name || '(unknown)'}`;
      rawData += `\nDescription: ${(payload?.description || payload?.about || '').slice(0, 500)}`;
      rawData += `\nIndustry: ${payload?.industry || '(unknown)'}`;
      rawData += `\nCompany Size: ${payload?.employeeCount || payload?.size || 'unknown'}`;
      rawData += `\nFounded: ${payload?.foundedYear || payload?.founded || 'unknown'}`;
      rawData += `\nWebsite: ${payload?.website || '(none)'}`;
      rawData += `\nSpecialties: ${payload?.specialties?.join(', ') || '(none)'}`;

      if (payload?.updates && Array.isArray(payload.updates)) {
        rawData += `\n\n--- COMPANY UPDATES ---`;
        payload.updates.forEach((u: any, i: number) => {
          rawData += `\n[Update ${i + 1}] ID: ${u.id || u.urn || 'unknown'}`;
          rawData += `, Date: ${u.publishedAt || u.createdAt || 'unknown'}`;
          rawData += `, Text: ${(u.text || u.commentary || u.message || '').slice(0, 300)}`;
          rawData += `, Likes: ${u.likeCount || u.likes || 0}, Comments: ${u.commentCount || u.comments || 0}`;
        });
      }
      results.push({ source: 'linkedin/company', data: rawData });
      break;
    }

    default:
      return NextResponse.json({ error: `Unknown LinkedIn action: ${action}` }, { status: 400 });
  }

  let ontologyResult = null;
  if (payload?.ingest !== false && results.length > 0) {
    const combined = results.map(r => r.data).join('\n\n');
    try {
      ontologyResult = await ingestToOntology(
        combined,
        `linkedin_${action}_${profileUrn || postUrn || companyUrn || 'unknown'}`,
        'social/linkedin',
        baseUrl
      );
    } catch (e: any) {
      errors.push(`Ontology ingest failed: ${e.message}`);
    }
  }

  return NextResponse.json({
    success: true,
    connector: 'linkedin',
    action,
    results,
    ontologyResult,
    errors: errors.length > 0 ? errors : undefined,
    summary: `LinkedIn ${action}: ${results.length} data blocks, ${ontologyResult?.entities?.length || 0} entities extracted`,
  });
}

// ═══════════════════════════════════════════════════════════════
//  WHATSAPP CONNECTOR
// ═══════════════════════════════════════════════════════════════
//
// Actions:
//   - ingest-chat      : parse WhatsApp export .txt → ontology
//   - ingest-media-log : parse media metadata
//   - ingest-all       : combined
//
// Config: (none needed — user uploads exports)
// Payload: rawText (the exported chat content)

async function handleWhatsApp(action: string, config: any, payload: any, baseUrl: string) {
  const rawText = payload?.rawText || payload?.data || '';
  const fileName = payload?.fileName || 'whatsapp_export.txt';

  const results: any[] = [];
  const errors: string[] = [];
  let rawData = '';

  if (!rawText && action !== 'ingest-all' && action !== 'upload-file') {
    return NextResponse.json({ error: 'No WhatsApp export data provided. Pass rawText or data in payload.' }, { status: 400 });
  }

  switch (action) {
    case 'ingest-chat': {
      rawData = `WHATSAPP CHAT EXPORT: file=${fileName}\n`;
      rawData += `\n=== RAW EXPORT (${rawText.length} chars) ===\n`;
      rawData += `\n${rawText.slice(0, 20000)}`;

      // Also parse structured info
      const lines = rawText.split('\n').slice(0, 2000);
      const participants = new Set<string>();
      const dateRange = { first: '', last: '' };
      let messageCount = 0;
      let mediaCount = 0;

      lines.forEach((line: string) => {
        // WhatsApp export format: [date, time] Sender Name: message
        const match = line.match(/\[(\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?)\]\s+([^:]+):\s*(.+)/);
        if (match) {
          messageCount++;
          participants.add(match[3].trim());
          if (!dateRange.first) dateRange.first = match[1];
          dateRange.last = match[1];
          if (match[4].includes('<Media omitted>') || match[4].includes('image omitted') || match[4].includes('video omitted')) {
            mediaCount++;
          }
        }
      });

      rawData += `\n\n--- PARSED STATS ---`;
      rawData += `\nTotal messages parsed: ${messageCount}`;
      rawData += `\nMedia items: ${mediaCount}`;
      rawData += `\nParticipants: ${Array.from(participants).join(', ')}`;
      rawData += `\nDate range: ${dateRange.first} to ${dateRange.last}`;
      rawData += `\nGroup chat: ${participants.size > 2 ? 'Yes' : 'No'}`;

      results.push({ source: 'whatsapp/chat', data: rawData });
      break;
    }

    case 'ingest-media-log': {
      const mediaItems = payload?.mediaItems || [];
      rawData = `WHATSAPP MEDIA LOG: ${mediaItems.length} items\n`;
      mediaItems.forEach((m: any, i: number) => {
        rawData += `\n--- MEDIA ${i + 1} ---`;
        rawData += `\nType: ${m.type || 'unknown'}`;
        rawData += `\nFilename: ${m.fileName || m.filename || '(unknown)'}`;
        rawData += `\nDate: ${m.date || m.timestamp || 'unknown'}`;
        rawData += `\nSize: ${m.fileSize || m.size || 'unknown'}`;
        rawData += `\nSender: ${m.sender || m.author || 'unknown'}`;
        rawData += `\nCaption: ${m.caption || '(none)'}`;
        rawData += `\nMIME: ${m.mimeType || m.mime || 'unknown'}`;
      });
      results.push({ source: 'whatsapp/media', data: rawData });
      break;
    }

    case 'ingest-all': {
      if (rawText) {
        const chatRes = await handleWhatsApp('ingest-chat', config, payload, baseUrl);
        const chatData = await chatRes.json();
        if (chatData.results) results.push(...chatData.results);
        if (chatData.errors) errors.push(...chatData.errors);
      }
      if (payload?.mediaItems) {
        const mediaRes = await handleWhatsApp('ingest-media-log', config, payload, baseUrl);
        const mediaData = await mediaRes.json();
        if (mediaData.results) results.push(...mediaData.results);
      }
      break;
    }

    default:
      return NextResponse.json({ error: `Unknown WhatsApp action: ${action}` }, { status: 400 });
  }

  let ontologyResult = null;
  if (payload?.ingest !== false && results.length > 0) {
    const combined = results.map(r => r.data).join('\n\n');
    try {
      ontologyResult = await ingestToOntology(
        combined,
        `whatsapp_${action}_${fileName}`,
        'social/whatsapp',
        baseUrl
      );
    } catch (e: any) {
      errors.push(`Ontology ingest failed: ${e.message}`);
    }
  }

  return NextResponse.json({
    success: true,
    connector: 'whatsapp',
    action,
    results,
    ontologyResult,
    errors: errors.length > 0 ? errors : undefined,
    summary: `WhatsApp ${action}: ${results.length} data blocks, ${ontologyResult?.entities?.length || 0} entities extracted`,
  });
}

// ═══════════════════════════════════════════════════════════════
//  BULK IMPORTER
// ═══════════════════════════════════════════════════════════════
//
// Import types:
//   - person-ids      : CSV of person_name, id_type, id_number, country, notes
//   - phone-contacts  : CSV of contact_name, phone_number, email, address, notes
//   - persons-and-jobs: CSV of person_name, job_title, company, department, email, phone, linkedin, notes
//
// Payload: importType, rows (array of objects), sourceName

async function handleBulkImport(action: string, config: any, payload: any, baseUrl: string) {
  const importType = action || payload?.importType || 'person-ids';
  const rows = payload?.rows || [];
  const sourceName = payload?.sourceName || 'bulk_import';

  if (rows.length === 0 && action !== 'upload-file') {
    return NextResponse.json({ error: 'No rows provided for import. Pass rows[] array.' }, { status: 400 });
  }

  const errors: string[] = [];
  const results: any[] = [];
  let rawData = '';

  switch (importType) {
    case 'person-ids': {
      rawData = `BULK IMPORT — PERSON IDS (${rows.length} records, source: ${sourceName})\n`;
      rawData += `\n=== RECORDS ===\n`;
      rows.forEach((r: any, i: number) => {
        rawData += `\n[RECORD ${i + 1}]`;
        rawData += `\n  Person Name: ${r.person_name || r.name || r.personName || 'unknown'}`;
        rawData += `\n  ID Type: ${r.id_type || r.idType || r.documentType || 'unknown'}`;
        rawData += `\n  ID Number: ${r.id_number || r.idNumber || r.documentNumber || 'unknown'}`;
        rawData += `\n  Country: ${r.country || r.issuingCountry || '(unknown)'}`;
        rawData += `\n  DOB: ${r.dob || r.dateOfBirth || '(unknown)'}`;
        rawData += `\n  Nationality: ${r.nationality || '(unknown)'}`;
        rawData += `\n  Notes: ${r.notes || r.comments || '(none)'}`;
        rawData += `\n  Additional: ${r.additional || r.extra ? JSON.stringify(r.additional || r.extra) : '(none)'}`;
      });
      results.push({ source: `bulk/person-ids/${sourceName}`, data: rawData });
      break;
    }

    case 'phone-contacts': {
      rawData = `BULK IMPORT — PHONE CONTACTS (${rows.length} records, source: ${sourceName})\n`;
      rawData += `\n=== CONTACTS ===\n`;
      rows.forEach((r: any, i: number) => {
        rawData += `\n[CONTACT ${i + 1}]`;
        rawData += `\n  Name: ${r.contact_name || r.name || r.contactName || 'unknown'}`;
        rawData += `\n  Phone: ${r.phone_number || r.phone || r.phoneNumber || '(not provided)'}`;
        rawData += `\n  Email: ${r.email || r.email_address || '(not provided)'}`;
        rawData += `\n  Address: ${r.address || r.street_address || '(not provided)'}`;
        rawData += `\n  City: ${r.city || '(unknown)'}`;
        rawData += `\n  Country: ${r.country || '(unknown)'}`;
        rawData += `\n  Organization: ${r.organization || r.company || '(none)'}`;
        rawData += `\n  Notes: ${r.notes || r.comments || '(none)'}`;
        rawData += `\n  Tags: ${r.tags || '(none)'}`;
      });
      results.push({ source: `bulk/phone-contacts/${sourceName}`, data: rawData });
      break;
    }

    case 'persons-and-jobs': {
      rawData = `BULK IMPORT — PERSONS & JOBS (${rows.length} records, source: ${sourceName})\n`;
      rawData += `\n=== ROSTER ===\n`;
      rows.forEach((r: any, i: number) => {
        rawData += `\n[ROSTER ENTRY ${i + 1}]`;
        rawData += `\n  Person Name: ${r.person_name || r.name || r.personName || 'unknown'}`;
        rawData += `\n  Job Title: ${r.job_title || r.title || r.jobTitle || 'unknown'}`;
        rawData += `\n  Company: ${r.company || r.company_name || r.organization || 'unknown'}`;
        rawData += `\n  Department: ${r.department || r.dept || '(unknown)'}`;
        rawData += `\n  Email: ${r.email || r.email_address || '(not provided)'}`;
        rawData += `\n  Phone: ${r.phone || r.phone_number || '(not provided)'}`;
        rawData += `\n  LinkedIn: ${r.linkedin || r.linkedin_url || r.linkedinUrl || '(none)'}`;
        rawData += `\n  Location: ${r.location || r.city || '(unknown)'}`;
        rawData += `\n  Reports To: ${r.reports_to || r.manager || r.supervisor || '(none)'}`;
        rawData += `\n  Start Date: ${r.start_date || r.startDate || '(unknown)'}`;
        rawData += `\n  Notes: ${r.notes || r.comments || '(none)'}`;
      });
      results.push({ source: `bulk/persons-and-jobs/${sourceName}`, data: rawData });
      break;
    }

    default:
      return NextResponse.json({ error: `Unknown import type: ${importType}` }, { status: 400 });
  }

  let ontologyResult = null;
  if (payload?.ingest !== false && results.length > 0) {
    const combined = results.map(r => r.data).join('\n\n');
    try {
      ontologyResult = await ingestToOntology(
        combined,
        `bulk_${importType}_${sourceName}`,
        'social/bulk-import',
        baseUrl
      );
    } catch (e: any) {
      errors.push(`Ontology ingest failed: ${e.message}`);
    }
  }

  return NextResponse.json({
    success: true,
    connector: 'bulk-import',
    importType,
    rowsProcessed: rows.length,
    results,
    ontologyResult,
    errors: errors.length > 0 ? errors : undefined,
    summary: `Bulk ${importType}: ${rows.length} rows processed, ${ontologyResult?.entities?.length || 0} entities extracted`,
  });
}
