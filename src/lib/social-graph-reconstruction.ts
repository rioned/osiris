/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Social Interaction Graph Reconstruction
 *
 *  Promotes raw social activity data into typed, directional
 *  relationships in the ontology graph:
 *
 *    follows, friend_of, liked, commented_on, replied_to, shared,
 *    mentioned, tagged, member_of, works_at
 *
 *  This turns scattered feed data into a queryable network —
 *  who follows whom, who commented on which YouTube post, who
 *  co-occurs in which groups — that the graph-analytics layer
 *  (communities, centrality, pathfinding) already operates on.
 *
 *  Each connector (X/Twitter, YouTube, Facebook, LinkedIn, etc.)
 *  can call reconstructFromFeed() at the end of its ingest cycle
 *  to build the typed edge layer automatically.
 * ═══════════════════════════════════════════════════════════════
 */

import {
  upsertEntity,
  createRelationship,
  getEntity,
  getEntities,
  ensureStore,
} from './store/entity-store';
import { PersonalEntity, PersonalDomain } from './personal-ontology';
import { enrichText } from './nlp/pipeline';
import { runStanceIntegration, type ActorStanceCollection, type StanceEvidence, type StanceProfile } from './nlp/stance';

// ── Social Relationship Types ──

export enum SocialRelation {
  FOLLOWS = 'follows',
  FRIEND_OF = 'friend_of',
  LIKED = 'liked',
  COMMENTED_ON = 'commented_on',
  REPLIED_TO = 'replied_to',
  SHARED = 'shared',
  MENTIONED = 'mentioned',
  TAGGED = 'tagged',
  MEMBER_OF = 'member_of',
  WORKS_AT = 'works_at',
}

/** All social relation types as an array for iteration. */
export const ALL_SOCIAL_RELATIONS: SocialRelation[] = Object.values(SocialRelation);

/** Directedness of each relation type. */
export const SOCIAL_RELATION_DIRECTED: Record<SocialRelation, boolean> = {
  [SocialRelation.FOLLOWS]: true,
  [SocialRelation.FRIEND_OF]: false,
  [SocialRelation.LIKED]: true,
  [SocialRelation.COMMENTED_ON]: true,
  [SocialRelation.REPLIED_TO]: true,
  [SocialRelation.SHARED]: true,
  [SocialRelation.MENTIONED]: true,
  [SocialRelation.TAGGED]: true,
  [SocialRelation.MEMBER_OF]: true,
  [SocialRelation.WORKS_AT]: true,
};

// ── Input Data Model ──

/**
 * A social actor — a person or profile that performs actions.
 * These get mapped to ontology entities (social_profile or person).
 */
export interface SocialActor {
  /** Platform-specific user ID (e.g. Twitter user ID, YouTube channel ID) */
  id: string;
  /** Display name */
  name: string;
  /** Username/handle (e.g. @elonmusk) */
  handle?: string;
  /** Platform: 'twitter', 'youtube', 'facebook', 'linkedin', 'whatsapp', 'telegram', 'generic' */
  platform: string;
  /** Profile URL */
  url?: string;
  /** Avatar/photo URL */
  avatarUrl?: string;
  /** Follower count (if available) */
  followerCount?: number;
  /** Bio/description */
  bio?: string;
  /** Extra properties merged into the entity */
  properties?: Record<string, any>;
}

/**
 * A social object — a post, comment, group, or media item
 * that actors interact with.
 */
export interface SocialObject {
  /** Platform-specific object ID */
  id: string;
  /** Type: 'post', 'comment', 'group', 'media', 'organization' */
  type: 'post' | 'comment' | 'group' | 'media' | 'organization';
  /** Platform */
  platform: string;
  /** Author ID (matches SocialActor.id) */
  authorId?: string;
  /** Text content (tweet text, comment text, post body) */
  text?: string;
  /** URL to the object */
  url?: string;
  /** Timestamp ISO string */
  timestamp?: string;
  /** Title (for posts/videos) */
  title?: string;
  /** Group/organization name */
  name?: string;
  /** Engagement metrics */
  likeCount?: number;
  commentCount?: number;
  shareCount?: number;
  /** Extra properties */
  properties?: Record<string, any>;
}

/**
 * A single social interaction record. This is the core unit
 * that gets turned into an ontology relationship.
 */
export interface SocialInteraction {
  /** One of the 10 typed relations */
  relation: SocialRelation;
  /** Actor performing the action (source) */
  actor: SocialActor;
  /** Target of the action (could be another actor or a social object) */
  target: SocialActor | SocialObject;
  /** Confidence/strength 0–1 (default 0.8) */
  strength?: number;
  /** Timestamp when the interaction occurred */
  timestamp?: string;
  /** Platform name (overrides actor.platform if set) */
  platform?: string;
  /** Extra metadata attached to the relationship */
  metadata?: Record<string, any>;
}

// ── Feed Parser Result ──

export interface ReconstructionResult {
  /** Entities created (actors + social objects) */
  entitiesCreated: number;
  /** Relationships created */
  relationshipsCreated: number;
  /** Detailed breakdown by relation type */
  breakdown: Record<string, { actors: number; objects: number; relationships: number }>;
  /** Warnings or skipped items */
  warnings: string[];
  /** Total interactions processed */
  totalInteractions: number;
}

// ── Core Reconstruction Entry Point ──

/**
 * Reconstruct the social graph from a batch of social interactions.
 *
 * For each interaction:
 *  1. Ensures the actor entity exists in the ontology store (upserts social_profile or person).
 *  2. Ensures the target entity exists (actor → social_profile/person, object → social_post/social_comment/social_group/organization).
 *  3. Creates the typed, directional relationship between source and target.
 *
 * Returns a summary of what was created.
 */
export async function reconstructSocialGraph(
  interactions: SocialInteraction[],
  source: string = 'social_reconstruction',
): Promise<ReconstructionResult> {
  await ensureStore();

  const result: ReconstructionResult = {
    entitiesCreated: 0,
    relationshipsCreated: 0,
    breakdown: {},
    warnings: [],
    totalInteractions: interactions.length,
  };

  // Initialise breakdown counters for each relation type.
  for (const rel of ALL_SOCIAL_RELATIONS) {
    result.breakdown[rel] = { actors: 0, objects: 0, relationships: 0 };
  }

  // Dedup cache to avoid redundant entity lookups/upserts within one batch.
  const actorCache = new Map<string, string>(); // actor platform+id → entity id
  const objectCache = new Map<string, string>(); // object platform+id → entity id

  for (const interaction of interactions) {
    const rel = interaction.relation;

    try {
      // ── Step 1: Resolve or create the actor entity ──
      const actorKey = `${interaction.actor.platform}:${interaction.actor.id}`;
      let actorEntityId = actorCache.get(actorKey);
      if (!actorEntityId) {
        actorEntityId = await resolveActorEntity(interaction.actor, source);
        actorCache.set(actorKey, actorEntityId);
        result.breakdown[rel].actors++;
        result.entitiesCreated++;
      }

      // ── Step 2: Resolve or create the target entity ──
      let targetEntityId: string | null = null;
      const isActorTarget = 'handle' in interaction.target || ('platform' in interaction.target && !('type' in interaction.target));

      if (isActorTarget) {
        // Target is another social actor (for follows, friend_of, etc.)
        const tgt = interaction.target as SocialActor;
        const targetKey = `${tgt.platform}:${tgt.id}`;
        targetEntityId = objectCache.get(targetKey);
        if (!targetEntityId) {
          targetEntityId = await resolveActorEntity(tgt, source);
          objectCache.set(targetKey, targetEntityId);
          result.breakdown[rel].objects++;
          result.entitiesCreated++;
        }
      } else {
        // Target is a social object (post, comment, group, org, media)
        const obj = interaction.target as SocialObject;
        const targetKey = `${obj.platform}:${obj.id}:${obj.type}`;
        targetEntityId = objectCache.get(targetKey);
        if (!targetEntityId) {
          targetEntityId = await resolveObjectEntity(obj, source);
          objectCache.set(targetKey, targetEntityId);
          result.breakdown[rel].objects++;
          result.entitiesCreated++;
        }
      }

      if (!targetEntityId) {
        result.warnings.push(`Skipped interaction: could not resolve target for ${rel}`);
        continue;
      }

      // ── Step 3: Create the relationship ──
      const strength = interaction.strength ?? 0.8;
      const metadata: Record<string, any> = {
        ...(interaction.metadata || {}),
        source,
        platform: interaction.platform || interaction.actor.platform,
      };
      if (interaction.timestamp) metadata.timestamp = interaction.timestamp;

      await createRelationship({
        sourceId: actorEntityId,
        targetId: targetEntityId,
        label: rel,
        strength,
        metadata,
      });

      result.breakdown[rel].relationships++;
      result.relationshipsCreated++;

      // ── Step 4: Target-stance & opinion mining ──
      // When the author creates a post/comment with text, analyze their
      // stance toward detected targets and update their entity profile.
      if (!isActorTarget) {
        const obj = interaction.target as SocialObject;
        const hasText = obj.text && obj.text.trim().length > 10;
        const isPostOrComment = obj.type === 'post' || obj.type === 'comment';

        if (hasText && isPostOrComment) {
          try {
            // Get current actor entity properties (may already have stance data)
            const actorEntity = await getEntity(actorEntityId);
            const existingStanceProfiles: Record<string, StanceProfile> | null =
              actorEntity?.properties?.stance_profiles || null;

            // Map interaction type
            let stanceInteractionType: StanceEvidence['interactionType'] = 'post';
            if (rel === 'liked') stanceInteractionType = 'like';
            else if (rel === 'shared') stanceInteractionType = 'share';
            else if (rel === 'commented_on' || rel === 'replied_to') stanceInteractionType = 'comment';
            else if (rel === 'mentioned') stanceInteractionType = 'post';

            const result = runStanceIntegration(
              actorEntityId,
              obj.text!,
              stanceInteractionType,
              interaction.timestamp || new Date().toISOString(),
              existingStanceProfiles,
              targetEntityId,
              interaction.platform || interaction.actor.platform,
            );

            // Update actor entity with stance properties if any targets scored
            if (result.scoredTargets.length > 0) {
              const updatedEntity = await getEntity(actorEntityId);
              if (updatedEntity) {
                await upsertEntity({
                  ...updatedEntity,
                  properties: {
                    ...updatedEntity.properties,
                    ...result.entityProperties,
                  },
                  tags: [...new Set([...updatedEntity.tags, ...result.tags])],
                });
              }
            }
          } catch (stanceErr: any) {
            // Stance integration is non-fatal
            if (process.env.NODE_ENV === 'development') {
              console.warn(`[Stance] Integration error: ${stanceErr.message}`);
            }
          }
        }
      }
    } catch (err: any) {
      result.warnings.push(`Error processing ${rel}: ${err.message}`);
    }
  }

  return result;
}

// ── Entity Resolution Helpers ──

/**
 * Resolve a social actor to an ontology entity (social_profile).
 * If the entity already exists (matched by ID), returns its existing ID.
 * Otherwise, creates a new social_profile entity.
 */
async function resolveActorEntity(actor: SocialActor, source: string): Promise<string> {
  const entityId = `social_${actor.platform}_${actor.id}`;

  // Check if already exists
  const existing = await getEntity(entityId);
  if (existing) return entityId;

  const handle = actor.handle || actor.name;
  const displayName = actor.name || handle;

  await upsertEntity({
    id: entityId,
    type: 'social_profile',
    domain: PersonalDomain.SOCIAL,
    label: `${displayName} (${actor.platform})`,
    description: actor.bio || `Social profile on ${actor.platform}`,
    properties: {
      platform: actor.platform,
      handle: handle,
      displayName: displayName,
      url: actor.url || '',
      avatarUrl: actor.avatarUrl || '',
      platformUserId: actor.id,
      followerCount: actor.followerCount ?? 0,
      ...(actor.properties || {}),
    },
    tags: ['social', actor.platform, 'auto'],
    source,
  });

  return entityId;
}

/**
 * Resolve a social object to an ontology entity.
 * Maps SocialObject.type to ontology type:
 *   post         → social_post
 *   comment      → social_comment
 *   group        → social_group
 *   media        → media
 *   organization → organization
 */
async function resolveObjectEntity(obj: SocialObject, source: string): Promise<string> {
  const entityId = `social_${obj.platform}_${obj.type}_${obj.id}`;

  const existing = await getEntity(entityId);
  if (existing) return entityId;

  const ontologyType = objectTypeToOntologyType(obj.type);
  const label = obj.title || obj.name || obj.text?.slice(0, 80) || `${obj.type} on ${obj.platform}`;

  const properties: Record<string, any> = {
    platform: obj.platform,
    platformId: obj.id,
    url: obj.url || '',
    timestamp: obj.timestamp || '',
    ...(obj.properties || {}),
  };

  // Type-specific properties
  if (obj.type === 'post' || obj.type === 'comment') {
    properties.text = obj.text || '';
    properties.author = obj.authorId || '';
    if (obj.likeCount !== undefined) properties.likeCount = obj.likeCount;
    if (obj.commentCount !== undefined) properties.commentCount = obj.commentCount;
    if (obj.shareCount !== undefined) properties.shareCount = obj.shareCount;
  }
  if (obj.type === 'group') {
    properties.name = obj.name || label;
    properties.memberCount = obj.likeCount || 0; // repurpose as member count
  }
  if (obj.type === 'organization') {
    properties.name = obj.name || label;
  }
  if (obj.type === 'media') {
    properties.uri = obj.url || '';
    properties.caption = obj.text || '';
  }

  // If this object has an author, link it as author ID in metadata
  if (obj.authorId) {
    properties.authorProfileId = `social_${obj.platform}_${obj.authorId}`;
  }

  await upsertEntity({
    id: entityId,
    type: ontologyType as any,
    domain: PersonalDomain.SOCIAL,
    label: label.slice(0, 200),
    description: obj.text?.slice(0, 500) || `${obj.type} on ${obj.platform}`,
    properties,
    tags: ['social', obj.platform, obj.type, 'auto'],
    source,
  });

  // ── NLP Enrichment: run language detection, NER, keyword & toxicity
  //    analysis on social post/comment text content ──
  if ((obj.type === 'post' || obj.type === 'comment') && obj.text && obj.text.trim().length > 5) {
    try {
      const enrichment = enrichText(obj.text);
      const nlpProps: Record<string, any> = {
        nlp_language: enrichment.language.code,
        nlp_toxicity_score: enrichment.toxicity.score,
        nlp_entity_count: enrichment.entities.length,
        nlp_enriched: true,
        nlp_enriched_at: new Date().toISOString(),
      };
      // Add detected entity names
      const people = enrichment.entities.filter(e => e.type === 'person').map(e => e.text);
      const orgs = enrichment.entities.filter(e => e.type === 'organization').map(e => e.text);
      const locs = enrichment.entities.filter(e => e.type === 'location').map(e => e.text);
      if (people.length > 0) nlpProps.nlp_detected_people = people.slice(0, 20);
      if (orgs.length > 0) nlpProps.nlp_detected_orgs = orgs.slice(0, 20);
      if (locs.length > 0) nlpProps.nlp_detected_locations = locs.slice(0, 20);
      if (enrichment.keywords.length > 0) {
        nlpProps.nlp_top_keywords = enrichment.keywords.slice(0, 10).map(k => k.term);
      }
      // Update entity with NLP properties
      const existing = await getEntity(entityId);
      if (existing) {
        await upsertEntity({
          ...existing,
          properties: { ...existing.properties, ...nlpProps },
          tags: [...new Set([...existing.tags, ...enrichment.tags])],
        });
      }
    } catch {
      // NLP enrichment is non-fatal
    }
  }

  return entityId;
}

// ── Feed-Format Parsers ──

/**
 * Parse raw X/Twitter connector output into structured SocialInteractions.
 * Handles: tweets (posts), replies, likes, retweets/shared, follows, mentions.
 */
export function parseTwitterFeed(
  rawData: string,
  platform: string = 'twitter',
): SocialInteraction[] {
  const interactions: SocialInteraction[] = [];
  const lines = rawData.split('\n');
  let currentSection = '';
  let mentions: string[] = [];
  let currentTweetAuthor = '';
  let currentTweetId = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Detect section headers
    if (line.startsWith('TWITTER PROFILE FETCH:')) {
      currentSection = 'profile';
      continue;
    }
    if (line.startsWith('TWITTER TWEETS FETCH:')) {
      currentSection = 'tweets';
      mentions = [];
      // Extract username from header
      const userMatch = line.match(/username=(\w+)/);
      if (userMatch) currentTweetAuthor = userMatch[1];
      continue;
    }
    if (line.startsWith('TWITTER THREAD FETCH:')) {
      currentSection = 'thread';
      mentions = [];
      continue;
    }
    if (line.startsWith('TWITTER FOLLOWERS FETCH:')) {
      currentSection = 'followers';
      continue;
    }
    if (line.startsWith('TWITTER FOLLOWING FETCH:')) {
      currentSection = 'following';
      continue;
    }
    if (line.startsWith('TWITTER SEARCH:')) {
      currentSection = 'search';
      continue;
    }

    // Extract username from the profile section
    if (currentSection === 'profile' && line.startsWith('Username:')) {
      const username = line.replace('Username:', '').trim();
      const handle = username.startsWith('@') ? username.slice(1) : username;
      currentTweetAuthor = handle;
      // Create a base actor for the profile owner
      const actor: SocialActor = {
        id: handle,
        name: handle,
        handle: `@${handle}`,
        platform,
      };
      // Followers count context
      let followerCount: number | undefined;
      let followingCount: number | undefined;
      for (const l of lines) {
        const flw = l.match(/Followers:\s*([\d,]+)/);
        if (flw) followerCount = parseInt(flw[1].replace(/,/g, ''), 10);
        const flg = l.match(/Following:\s*([\d,]+)/);
        if (flg) followingCount = parseInt(flg[1].replace(/,/g, ''), 10);
      }
      actor.followerCount = followerCount;
      actor.properties = { followingCount };
      continue;
    }

    // Extract tweet/reply data
    if (line.startsWith('--- TWEET') || line.startsWith('--- THREAD POST') || line.startsWith('--- SEARCH RESULT')) {
      currentSection = 'tweet-detail';
      mentions = [];
      currentTweetId = '';
      continue;
    }
    if (line.startsWith('--- REPLY')) {
      currentSection = 'reply-detail';
      continue;
    }
    if (line.startsWith('--- FOLLOWER') || line.startsWith('--- FOLLOWING')) {
      currentSection = 'follower-detail';
      continue;
    }

    // Parse tweet detail fields
    if (currentSection === 'tweet-detail' || currentSection === 'reply-detail') {
      const idMatch = line.match(/^ID:\s*(\S+)/);
      if (idMatch) {
        currentTweetId = idMatch[1];
        continue;
      }
      const authorMatch = line.match(/^Author:\s*@?(\S+)/);
      if (authorMatch) {
        currentTweetAuthor = authorMatch[1];
        mentions = [];
        continue;
      }

      // Use username from parent tweet section as the author if no Author: line
      let tweetAuthorForThisTweet = currentTweetAuthor;
      if (!tweetAuthorForThisTweet && (currentSection === 'tweet-detail')) {
        // Try to extract from the section header or use the parent-level username
      }

      const textMatch = line.match(/^Text:\s*(.+)/);
      if (textMatch) {
        // Check for @mentions in text
        const atMentions = textMatch[1].match(/@(\w+)/g);
        if (atMentions) {
          mentions = atMentions.map((m: string) => m.replace('@', ''));
        }
        continue;
      }

      // Parse Mentions: line directly (format: "Mentions: @user1, @user2")
      const mentionsLine = line.match(/^Mentions:\s*(.+)/);
      if (mentionsLine && mentionsLine[1] && mentionsLine[1] !== '(none)') {
        // Extract @mentions from the mentions field
        const atMentions = mentionsLine[1].match(/@(\w+)/g);
        if (atMentions) {
          mentions = atMentions.map((m: string) => m.replace('@', ''));
        }
        continue;
      }
      const likesMatch = line.match(/^Likes:\s*(\d+)/);
      if (likesMatch && currentTweetAuthor) {
        // If this is a reply section, create replied_to
        if (currentSection === 'reply-detail' && currentTweetId) {
          const replyAuthor: SocialActor = {
            id: currentTweetAuthor,
            name: currentTweetAuthor,
            handle: `@${currentTweetAuthor}`,
            platform,
          };
          // This is a reply — target is the parent post
          const parentPost: SocialObject = {
            id: currentTweetId,
            type: 'post',
            platform,
            authorId: currentTweetAuthor,
          };
          interactions.push({
            relation: SocialRelation.REPLIED_TO,
            actor: replyAuthor,
            target: parentPost,
            strength: 0.9,
          });
        }
        // Process @mentions as 'mentioned' relations
        for (const mentionedUser of mentions) {
          const mentionActor: SocialActor = {
            id: currentTweetAuthor,
            name: currentTweetAuthor,
            handle: `@${currentTweetAuthor}`,
            platform,
          };
          const mentionedTarget: SocialActor = {
            id: mentionedUser,
            name: mentionedUser,
            handle: `@${mentionedUser}`,
            platform,
          };
          interactions.push({
            relation: SocialRelation.MENTIONED,
            actor: mentionActor,
            target: mentionedTarget,
            strength: 0.7,
          });
        }
        mentions = [];
        continue;
      }
      const retweetsMatch = line.match(/^Retweets:\s*(\d+)/);
      if (retweetsMatch && currentTweetAuthor && currentTweetId) {
        // Retweet = share
        const retweetActor: SocialActor = {
          id: currentTweetAuthor,
          name: currentTweetAuthor,
          handle: `@${currentTweetAuthor}`,
          platform,
        };
        const tweetPost: SocialObject = {
          id: currentTweetId,
          type: 'post',
          platform,
          authorId: currentTweetAuthor,
        };
        interactions.push({
          relation: SocialRelation.SHARED,
          actor: retweetActor,
          target: tweetPost,
          strength: 0.8,
        });
        continue;
      }
    }

    // Parse follower/following detail → follows relationships
    if (currentSection === 'follower-detail' && line.startsWith('Username:')) {
      const username = line.replace('Username:', '').trim();
      const handle = username.startsWith('@') ? username.slice(1) : username;
      // Follower follows the main profile owner
      if (currentTweetAuthor) {
        const followerActor: SocialActor = {
          id: handle,
          name: handle,
          handle: `@${handle}`,
          platform,
        };
        const profileOwner: SocialActor = {
          id: currentTweetAuthor,
          name: currentTweetAuthor,
          handle: `@${currentTweetAuthor}`,
          platform,
        };
        interactions.push({
          relation: SocialRelation.FOLLOWS,
          actor: followerActor,
          target: profileOwner,
          strength: 0.95,
          metadata: { followerSource: 'follower_list' },
        });
      }
    }
    if (currentSection === 'follower-detail' && line.startsWith('Display Name:')) {
      // skip — we already created the follows from Username
      continue;
    }

    // Special: ingest-all section
    if (line.startsWith('--- SCRAPED DATA') || line.startsWith('(Payload tweets')) {
      continue;
    }
  }

  return interactions;
}

/**
 * Parse raw YouTube connector output into structured SocialInteractions.
 * Handles: channel subscription (follows), comments (commented_on), replies, likes.
 */
export function parseYouTubeFeed(
  rawData: string,
  platform: string = 'youtube',
): SocialInteraction[] {
  const interactions: SocialInteraction[] = [];
  const lines = rawData.split('\n');
  let currentSection = '';
  let currentVideoId = '';
  let currentVideoAuthor = '';
  let currentCommentAuthor = '';
  let currentCommentId = '';
  let isReplySection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('YOUTUBE CHANNEL FETCH:')) {
      currentSection = 'channel';
      continue;
    }
    if (line.startsWith('YOUTUBE VIDEO FETCH:')) {
      currentSection = 'video';
      continue;
    }
    if (line.startsWith('YOUTUBE COMMENTS FETCH:')) {
      currentSection = 'comments';
      continue;
    }
    if (line.startsWith('YOUTUBE SEARCH:')) {
      currentSection = 'search';
      continue;
    }

    // Channel section: extract channel info
    if (currentSection === 'channel') {
      const titleMatch = line.match(/^Title:\s*(.+)/);
      if (titleMatch) {
        currentVideoAuthor = titleMatch[1];
        continue;
      }
      // Parse subscriber count
      const subsMatch = line.match(/^Subscribers:\s*([\d,]+)/);
      if (subsMatch) {
        // channel owner as actor
        if (currentVideoAuthor) {
          const channelActor: SocialActor = {
            id: currentVideoAuthor.toLowerCase().replace(/\s+/g, '_'),
            name: currentVideoAuthor,
            platform,
            followerCount: parseInt(subsMatch[1].replace(/,/g, ''), 10),
          };
          // This actor owns the channel
          // Skip — no follows relationship from channel data alone
          // unless we have subscriber data (follows from subscribers → channel)
        }
        continue;
      }

      // Parse videos as posts
      const videoMatch = line.match(/^\[VIDEO (\d+)\]/);
      if (videoMatch) {
        currentSection = 'video-detail';
        continue;
      }
      if (currentSection === 'video-detail') {
        const vidIdMatch = line.match(/^ID:\s*(\S+)/);
        if (vidIdMatch) {
          currentVideoId = vidIdMatch[1];
          continue;
        }
        const vidTitle = line.match(/^Title:\s*(.+)/);
        if (vidTitle && currentVideoId && currentVideoAuthor) {
          // Video as a social_post object
          continue;
        }
        if (!line.startsWith('[') && !line.includes(':')) {
          currentSection = 'channel';
        }
        continue;
      }
    }

    // Video section: extract video + comments
    if (currentSection === 'video') {
      const vidIdMatch = line.match(/^Title:\s*(.+)/);
      if (vidIdMatch) {
        // We need video ID from context
        continue;
      }
      const channelMatch = line.match(/^Channel:\s*(.+)/);
      if (channelMatch) {
        currentVideoAuthor = channelMatch[1];
        continue;
      }
      const channelIdMatch = line.match(/^Channel ID:\s*(.+)/);
      if (channelIdMatch) {
        currentVideoId = channelIdMatch[1];
        continue;
      }
      const vidId2Match = line.match(/^Views:\s*([\d,]+)/);
      if (vidId2Match) {
        // After views, comments section might follow — reset comment context
        currentCommentAuthor = '';
        currentCommentId = '';
        isReplySection = false;
        continue;
      }

      // Parse comments within video section
      const commentMatch = line.match(/^\[COMMENT (\d+)\]/);
      if (commentMatch) {
        isReplySection = false;
        currentCommentId = `comment_${commentMatch[1]}`;
        continue;
      }
      const commentAuthor = line.match(/^Author:\s*(.+)/);
      if (commentAuthor && currentCommentId) {
        currentCommentAuthor = commentAuthor[1];
        continue;
      }
      const authorChannelMatch = line.match(/^Author Channel ID:\s*(.+)/);
      if (authorChannelMatch && currentCommentAuthor && currentVideoId && currentCommentId) {
        // Build commented_on relationship
        const commenter: SocialActor = {
          id: currentCommentAuthor.toLowerCase().replace(/\s+/g, '_'),
          name: currentCommentAuthor,
          platform,
        };
        const vidPost: SocialObject = {
          id: currentVideoId,
          type: 'post',
          platform,
          authorId: currentVideoAuthor ? currentVideoAuthor.toLowerCase().replace(/\s+/g, '_') : '',
        };
        interactions.push({
          relation: SocialRelation.COMMENTED_ON,
          actor: commenter,
          target: vidPost,
          strength: 0.85,
        });
        continue;
      }
      const commentText = line.match(/^Text:\s*(.+)/);
      if (commentText && currentCommentId) {
        // Check for @mentions in comment text
        const atMentions = commentText[1].match(/@(\w+)/g);
        if (atMentions && currentCommentAuthor) {
          for (const m of atMentions) {
            const mentionedUser = m.replace('@', '');
            const mentionActor: SocialActor = {
              id: currentCommentAuthor.toLowerCase().replace(/\s+/g, '_'),
              name: currentCommentAuthor,
              platform,
            };
            const mentionedTarget: SocialActor = {
              id: mentionedUser,
              name: mentionedUser,
              handle: `@${mentionedUser}`,
              platform,
            };
            interactions.push({
              relation: SocialRelation.MENTIONED,
              actor: mentionActor,
              target: mentionedTarget,
              strength: 0.7,
            });
          }
        }
        continue;
      }

      // Parse replies
      const replyMatch = line.match(/^\s*\[REPLY (\d+)\]/);
      if (replyMatch) {
        isReplySection = true;
        continue;
      }
      if (isReplySection) {
        const replyAuthor = line.match(/Author=([^,]+)/);
        if (replyAuthor && currentVideoId) {
          const replyActor: SocialActor = {
            id: replyAuthor[1].toLowerCase().replace(/\s+/g, '_'),
            name: replyAuthor[1],
            platform,
          };
          const parentComment: SocialObject = {
            id: currentCommentId,
            type: 'comment',
            platform,
            authorId: currentCommentAuthor ? currentCommentAuthor.toLowerCase().replace(/\s+/g, '_') : '',
          };
          interactions.push({
            relation: SocialRelation.REPLIED_TO,
            actor: replyActor,
            target: parentComment,
            strength: 0.9,
          });
        }
        // Parse likes on replies
        const replyLikes = line.match(/Likes=(\d+)/);
        if (replyLikes && currentCommentAuthor) {
          // Skip — we can't determine who liked exactly
        }
        // After reply, reset
        if (!line.startsWith('Reply') && !line.startsWith('  ')) {
          isReplySection = false;
        }
        continue;
      }

      const commentLikes = line.match(/^Likes:\s*(\d+)/);
      if (commentLikes && currentCommentAuthor && currentVideoId) {
        // Parse likes on the video itself (not comments)
        continue;
      }

      // End of comment section reset
      if (!line.startsWith('[') && !line.startsWith('Author') && !line.startsWith('Text') &&
          !line.startsWith('  [REPLY') && !line.startsWith('Likes') && line !== '') {
        currentCommentId = '';
        currentCommentAuthor = '';
      }
    }

    // Comments-only section
    if (currentSection === 'comments') {
      const commentNum = line.match(/^--- COMMENT (\d+) ---/);
      if (commentNum) {
        currentCommentId = `comment_${commentNum[1]}`;
        continue;
      }
      const cAuthor = line.match(/^Author:\s*(.+)/);
      if (cAuthor) {
        currentCommentAuthor = cAuthor[1];
        continue;
      }
      const cAuthorChannel = line.match(/^Author Channel ID:\s*(.+)/);
      if (cAuthorChannel && currentCommentAuthor && currentVideoId) {
        const commenter: SocialActor = {
          id: currentCommentAuthor.toLowerCase().replace(/\s+/g, '_'),
          name: currentCommentAuthor,
          platform,
        };
        const vidPost: SocialObject = {
          id: currentVideoId,
          type: 'post',
          platform,
        };
        interactions.push({
          relation: SocialRelation.COMMENTED_ON,
          actor: commenter,
          target: vidPost,
          strength: 0.85,
        });
        continue;
      }
      const cText = line.match(/^Text:\s*(.+)/);
      if (cText && currentCommentAuthor && currentVideoId) {
        // @mentions in comment text
        const atMentions = cText[1].match(/@(\w+)/g);
        if (atMentions) {
          for (const m of atMentions) {
            const mentionActor: SocialActor = {
              id: currentCommentAuthor.toLowerCase().replace(/\s+/g, '_'),
              name: currentCommentAuthor,
              platform,
            };
            const mentionedTarget: SocialActor = {
              id: m.replace('@', ''),
              name: m.replace('@', ''),
              platform,
            };
            interactions.push({
              relation: SocialRelation.MENTIONED,
              actor: mentionActor,
              target: mentionedTarget,
              strength: 0.7,
            });
          }
        }
        continue;
      }

      // Reply parsing
      if (line.includes('Reply') && line.includes('Author=')) {
        const replyAuthorMatch = line.match(/Author=([^,]+)/);
        if (replyAuthorMatch && currentCommentId) {
          const replyActor: SocialActor = {
            id: replyAuthorMatch[1].toLowerCase().replace(/\s+/g, '_'),
            name: replyAuthorMatch[1],
            platform,
          };
          const parentComment: SocialObject = {
            id: currentCommentId,
            type: 'comment',
            platform,
          };
          interactions.push({
            relation: SocialRelation.REPLIED_TO,
            actor: replyActor,
            target: parentComment,
            strength: 0.9,
          });
        }
        continue;
      }
    }
  }

  return interactions;
}

// ── Helper ──

function objectTypeToOntologyType(objType: string): string {
  switch (objType) {
    case 'post': return 'social_post';
    case 'comment': return 'social_comment';
    case 'group': return 'social_group';
    case 'media': return 'media';
    case 'organization': return 'organization';
    default: return 'social_post';
  }
}

/**
 * Generic feed parser that tries to extract social interactions
 * from raw text using regex patterns common across platforms.
 * Handles lines containing: follows, liked, commented_on, replied_to,
 * shared, mentioned, member_of, works_at, tagged, friend_of.
 */
export function parseGenericFeed(
  rawData: string,
  platform: string,
): SocialInteraction[] {
  const interactions: SocialInteraction[] = [];
  const lines = rawData.split('\n');

  // Pattern: "username action target"
  // e.g. "elonmusk follows joe_biden"
  // e.g. "john.doe liked post_123"
  // e.g. "@alice commented on post_456"
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('---') || trimmed.startsWith('//')) continue;

    // Try each pattern
    const followMatch = trimmed.match(
      /(?:@)?(\w[\w.\-]+)\s+(?:follows|following|subscribed_to)\s+(?:@)?(\w[\w.\-]+)/i,
    );
    if (followMatch) {
      interactions.push({
        relation: 'follows' as any,
        actor: { id: followMatch[1], name: followMatch[1], handle: `@${followMatch[1]}`, platform },
        target: { id: followMatch[2], name: followMatch[2], handle: `@${followMatch[2]}`, platform },
        strength: 0.8,
      });
      continue;
    }

    const likedMatch = trimmed.match(
      /(?:@)?(\w[\w.\-]+)\s+(?:liked|favorited)\s+(.+)/i,
    );
    if (likedMatch) {
      interactions.push({
        relation: 'liked' as any,
        actor: { id: likedMatch[1], name: likedMatch[1], platform },
        target: { id: likedMatch[2], type: 'post', platform },
        strength: 0.7,
      });
      continue;
    }

    const commentMatch = trimmed.match(
      /(?:@)?(\w[\w.\-]+)\s+(?:commented on|commented_on)\s+(.+)/i,
    );
    if (commentMatch) {
      interactions.push({
        relation: 'commented_on' as any,
        actor: { id: commentMatch[1], name: commentMatch[1], platform },
        target: { id: commentMatch[2], type: 'post', platform },
        strength: 0.85,
      });
      continue;
    }

    const shareMatch = trimmed.match(
      /(?:@)?(\w[\w.\-]+)\s+(?:shared|retweeted|reposted)\s+(.+)/i,
    );
    if (shareMatch) {
      interactions.push({
        relation: 'shared' as any,
        actor: { id: shareMatch[1], name: shareMatch[1], platform },
        target: { id: shareMatch[2], type: 'post', platform },
        strength: 0.8,
      });
      continue;
    }

    const replyMatch = trimmed.match(
      /(?:@)?(\w[\w.\-]+)\s+(?:replied to|replied_to)\s+(?:@)?(\w[\w.\-]+)/i,
    );
    if (replyMatch) {
      interactions.push({
        relation: 'replied_to' as any,
        actor: { id: replyMatch[1], name: replyMatch[1], platform },
        target: { id: replyMatch[2], name: replyMatch[2], platform },
        strength: 0.9,
      });
      continue;
    }

    const mentionMatch = trimmed.match(
      /(?:@)?(\w[\w.\-]+)\s+(?:mentioned)\s+(?:@)?(\w[\w.\-]+)/i,
    );
    if (mentionMatch) {
      interactions.push({
        relation: 'mentioned' as any,
        actor: { id: mentionMatch[1], name: mentionMatch[1], platform },
        target: { id: mentionMatch[2], name: mentionMatch[2], platform },
        strength: 0.7,
      });
      continue;
    }

    const memberMatch = trimmed.match(
      /(?:@)?(\w[\w.\-]+)\s+(?:member of|member_of|joined)\s+(.+)/i,
    );
    if (memberMatch) {
      interactions.push({
        relation: 'member_of' as any,
        actor: { id: memberMatch[1], name: memberMatch[1], platform },
        target: { id: memberMatch[2].toLowerCase().replace(/\s+/g, '_'), type: 'group', platform, name: memberMatch[2] },
        strength: 0.9,
      });
      continue;
    }

    const workMatch = trimmed.match(
      /(?:@)?(\w[\w.\-]+)\s+(?:works at|works_at|employed by)\s+(.+)/i,
    );
    if (workMatch) {
      interactions.push({
        relation: 'works_at' as any,
        actor: { id: workMatch[1], name: workMatch[1], platform },
        target: { id: workMatch[2].toLowerCase().replace(/\s+/g, '_'), type: 'organization', platform, name: workMatch[2] },
        strength: 0.9,
      });
      continue;
    }

    const friendMatch = trimmed.match(
      /(?:@)?(\w[\w.\-]+)\s+(?:friend of|friend_of|friends with)\s+(?:@)?(\w[\w.\-]+)/i,
    );
    if (friendMatch) {
      interactions.push({
        relation: 'friend_of' as any,
        actor: { id: friendMatch[1], name: friendMatch[1], platform },
        target: { id: friendMatch[2], name: friendMatch[2], platform },
        strength: 0.85,
      });
      continue;
    }

    // Tag pattern: "user tagged another_user in post_123"
    const tagMatch = trimmed.match(
      /(?:@)?(\w[\w.\-]+)\s+(?:tagged)\s+(?:@)?(\w[\w.\-]+)\s+in\s+(.+)/i,
    );
    if (tagMatch) {
      interactions.push({
        relation: 'tagged' as any,
        actor: { id: tagMatch[1], name: tagMatch[1], platform },
        target: { id: tagMatch[3], name: tagMatch[3], platform },
        strength: 0.8,
        metadata: { taggedUser: tagMatch[2], taggedBy: tagMatch[1] },
      });
      continue;
    }
  }

  return interactions;
}
