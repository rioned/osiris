/**
 * ════════════════════════════════════════════════════════════════
 *  OSIRIS — Ontology Registry (shared parser)
 *
 *  Single source of truth for reading the declarative ontology
 *  definitions in `osiris-foundation/ontology/*.yaml`.
 *
 *  Used by:
 *    • GET /api/ontology/types        — serves the registry to the UI
 *    • src/lib/store/ontology-loader  — upserts the registry into
 *                                       Postgres (ontology.object_types
 *                                       / ontology.link_types) on boot
 *
 *  Keeping one parser here means the API and the DB loader can never
 *  drift apart — the declarative YAML in `osiris-foundation/` is the
 *  core, and everything else reads it through this module.
 * ════════════════════════════════════════════════════════════════
 */

import { promises as fs } from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';

// ── Type Definitions ──

export interface PropertyDef {
  type: string;
  label: string;
  required: boolean;
  searchable: boolean;
  pii: boolean;
  embed: boolean;
  enum?: string[];
  description?: string;
}

export interface ObjectType {
  type: string;
  domain: string;
  label: string;
  description: string;
  icon: string;
  color: string;
  properties: Record<string, PropertyDef>;
}

export interface LinkType {
  type: string;
  label: string;
  description: string;
  directed: boolean;
  sourceTypes: string[];
  targetTypes: string[];
  strength: number;
}

export interface OntologyRegistry {
  objectTypes: ObjectType[];
  linkTypes: LinkType[];
}

// Absolute path to the foundation ontology folder (the project core).
export const ONTOLOGY_DIR = path.join(process.cwd(), 'osiris-foundation', 'ontology');

// Default object-type colour when the foundation YAML omits one (OSIRIS gold).
export const DEFAULT_TYPE_COLOR = '#D4AF37';

// ── Normalisation Helpers ──

// Turn a snake_case / camelCase property key into a human label.
export function humanizeKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

// Normalise a YAML property definition to the PropertyDef shape the UI expects.
export function normalizeProperty(key: string, def: any): PropertyDef {
  const d = def || {};
  return {
    type: d.type || 'string',
    label: d.label || humanizeKey(key),
    required: !!d.required,
    searchable: !!d.searchable,
    pii: !!d.pii,
    embed: !!d.embed,
    // foundation YAML uses `values:` for enums; UI expects `enum`
    enum: d.enum || d.values || undefined,
    description: d.description || undefined,
  };
}

export function normalizeProperties(props: any): Record<string, PropertyDef> {
  const out: Record<string, PropertyDef> = {};
  if (props && typeof props === 'object') {
    for (const [key, def] of Object.entries(props)) {
      out[key] = normalizeProperty(key, def);
    }
  }
  return out;
}

// ── YAML Parsers ──

export async function parseObjectTypes(): Promise<ObjectType[]> {
  const ymlPath = path.join(ONTOLOGY_DIR, 'object-types.yaml');
  let content: string;
  try {
    content = await fs.readFile(ymlPath, 'utf-8');
  } catch {
    // Fallback: return basic built-in types if file missing
    return getFallbackObjectTypes();
  }

  const parsed = yaml.load(content) as any;
  if (!parsed || !parsed.object_types) return getFallbackObjectTypes();

  const types: ObjectType[] = [];

  // Foundation schema: `object_types` is a MAP of <typeName> -> { domain, display_name, ... }.
  // Tolerate a legacy shape where the value is an array of type defs grouped by domain.
  for (const [key, value] of Object.entries(parsed.object_types)) {
    if (Array.isArray(value)) {
      for (const t of value as any[]) {
        types.push({
          type: t.type || t.name,
          domain: (t.domain || key).toUpperCase(),
          label: t.display_name || t.label || t.name || t.type,
          description: t.description || '',
          icon: t.icon || '📦',
          color: t.color || DEFAULT_TYPE_COLOR,
          properties: normalizeProperties(t.properties),
        });
      }
    } else if (value && typeof value === 'object') {
      const t = value as any;
      types.push({
        type: t.type || t.name || key,
        domain: (t.domain || 'GENERAL').toUpperCase(),
        label: t.display_name || t.label || humanizeKey(key),
        description: t.description || '',
        icon: t.icon || '📦',
        color: t.color || DEFAULT_TYPE_COLOR,
        properties: normalizeProperties(t.properties),
      });
    }
  }

  return types.length > 0 ? types : getFallbackObjectTypes();
}

export async function parseLinkTypes(): Promise<LinkType[]> {
  const ymlPath = path.join(ONTOLOGY_DIR, 'link-types.yaml');
  let content: string;
  try {
    content = await fs.readFile(ymlPath, 'utf-8');
  } catch {
    return getFallbackLinkTypes();
  }

  const parsed = yaml.load(content) as any;
  if (!parsed || !parsed.link_types) return getFallbackLinkTypes();

  // Foundation schema: `link_types` is a MAP of <linkName> -> { display_name, ... }.
  // Tolerate a legacy array-of-defs shape too.
  const entries: [string, any][] = Array.isArray(parsed.link_types)
    ? (parsed.link_types as any[]).map((l) => [l.type || l.name, l])
    : Object.entries(parsed.link_types);

  const links = entries.map(([key, l]) => ({
    type: l.type || l.name || key,
    label: l.display_name || l.label || humanizeKey(key),
    description: l.description || '',
    directed: l.directed !== false,
    sourceTypes: l.source_types || l.sourceTypes || ['*'],
    targetTypes: l.target_types || l.targetTypes || ['*'],
    strength: typeof l.strength === 'number' ? l.strength : 0.5,
  }));

  return links.length > 0 ? links : getFallbackLinkTypes();
}

/** Parse the full ontology registry (object + link types) from the foundation YAML. */
export async function parseOntologyRegistry(): Promise<OntologyRegistry> {
  const [objectTypes, linkTypes] = await Promise.all([
    parseObjectTypes(),
    parseLinkTypes(),
  ]);
  return { objectTypes, linkTypes };
}

// ── Fallback Types (when YAML files are missing) ──

export function getFallbackObjectTypes(): ObjectType[] {
  return [
    {
      type: 'person', domain: 'PERSON', label: 'Person', icon: '👤', color: '#D4AF37',
      description: 'An individual person of interest',
      properties: {
        fullName: { type: 'string', label: 'Full Name', required: true, searchable: true, pii: true, embed: true },
        email: { type: 'string', label: 'Email', required: false, searchable: true, pii: true, embed: false },
        phone: { type: 'string', label: 'Phone', required: false, searchable: true, pii: true, embed: false },
        nationality: { type: 'string', label: 'Nationality', required: false, searchable: true, pii: false, embed: false },
        occupation: { type: 'string', label: 'Occupation', required: false, searchable: true, pii: false, embed: false },
        dob: { type: 'string', label: 'Date of Birth', required: false, searchable: false, pii: true, embed: false },
        aliases: { type: 'string[]', label: 'Aliases', required: false, searchable: true, pii: false, embed: true },
      },
    },
    {
      type: 'phone_number', domain: 'COMMUNICATION', label: 'Phone Number', icon: '📞', color: '#4F6FFF',
      description: 'A telephone number associated with a person or entity',
      properties: {
        number: { type: 'string', label: 'Phone Number', required: true, searchable: true, pii: true, embed: false },
        carrier: { type: 'string', label: 'Carrier', required: false, searchable: true, pii: false, embed: false },
        country: { type: 'string', label: 'Country Code', required: false, searchable: true, pii: false, embed: false },
        contactName: { type: 'string', label: 'Contact Name', required: false, searchable: true, pii: true, embed: false },
      },
    },
    {
      type: 'social_profile', domain: 'SOCIAL', label: 'Social Media Profile', icon: '🌐', color: '#8A63D2',
      description: 'A social media account on any platform',
      properties: {
        platform: { type: 'enum', label: 'Platform', required: true, searchable: true, pii: false, embed: false, enum: ['X', 'FB', 'IG', 'LI', 'TG', 'WA', 'SC', 'TT', 'YT', 'RD'] },
        username: { type: 'string', label: 'Username', required: true, searchable: true, pii: false, embed: true },
        url: { type: 'string', label: 'Profile URL', required: false, searchable: true, pii: false, embed: false },
        displayName: { type: 'string', label: 'Display Name', required: false, searchable: true, pii: true, embed: true },
        bio: { type: 'string', label: 'Bio', required: false, searchable: true, pii: false, embed: true },
        followers: { type: 'number', label: 'Followers', required: false, searchable: false, pii: false, embed: false },
      },
    },
    {
      type: 'identity_document', domain: 'IDENTITY', label: 'Identity Document', icon: '🪪', color: '#E8743B',
      description: 'A government-issued ID document',
      properties: {
        idType: { type: 'enum', label: 'Document Type', required: true, searchable: true, pii: false, embed: false, enum: ['Passport', 'DL', 'ID', 'Visa', 'Other'] },
        idNumber: { type: 'string', label: 'ID Number', required: true, searchable: true, pii: true, embed: false },
        issuingCountry: { type: 'string', label: 'Issuing Country', required: false, searchable: true, pii: false, embed: false },
        fullName: { type: 'string', label: 'Full Name on Document', required: false, searchable: true, pii: true, embed: false },
        expiryDate: { type: 'date', label: 'Expiry Date', required: false, searchable: false, pii: false, embed: false },
      },
    },
    {
      type: 'vehicle', domain: 'VEHICLE', label: 'Vehicle', icon: '🚗', color: '#3BA776',
      description: 'A motor vehicle of interest',
      properties: {
        plate: { type: 'string', label: 'License Plate', required: false, searchable: true, pii: false, embed: false },
        vin: { type: 'string', label: 'VIN', required: false, searchable: true, pii: false, embed: false },
        make: { type: 'string', label: 'Make', required: false, searchable: true, pii: false, embed: false },
        model: { type: 'string', label: 'Model', required: false, searchable: true, pii: false, embed: false },
        year: { type: 'number', label: 'Year', required: false, searchable: false, pii: false, embed: false },
        color: { type: 'string', label: 'Color', required: false, searchable: true, pii: false, embed: false },
        owner: { type: 'string', label: 'Owner', required: false, searchable: true, pii: true, embed: false },
      },
    },
    {
      type: 'place', domain: 'LOCATION', label: 'Place / Location', icon: '📍', color: '#E84855',
      description: 'A physical location or address',
      properties: {
        address: { type: 'string', label: 'Address', required: false, searchable: true, pii: false, embed: true },
        city: { type: 'string', label: 'City', required: false, searchable: true, pii: false, embed: false },
        country: { type: 'string', label: 'Country', required: false, searchable: true, pii: false, embed: false },
        placeType: { type: 'enum', label: 'Place Type', required: false, searchable: true, pii: false, embed: false, enum: ['Home', 'Work', 'Public', 'Other'] },
        residents: { type: 'string[]', label: 'Residents', required: false, searchable: true, pii: true, embed: false },
      },
    },
    {
      type: 'mac_address', domain: 'NETWORK', label: 'MAC Address', icon: '🖥️', color: '#00C2A8',
      description: 'A device MAC address observed on a network',
      properties: {
        mac: { type: 'string', label: 'MAC Address', required: true, searchable: true, pii: false, embed: false },
        vendor: { type: 'string', label: 'Vendor / OUI', required: false, searchable: true, pii: false, embed: false },
        deviceName: { type: 'string', label: 'Device Name', required: false, searchable: true, pii: false, embed: false },
        owner: { type: 'string', label: 'Owner', required: false, searchable: true, pii: true, embed: false },
        wifiNetworks: { type: 'string[]', label: 'WiFi Networks Seen', required: false, searchable: true, pii: false, embed: false },
      },
    },
    {
      type: 'wifi_network', domain: 'NETWORK', label: 'WiFi Network', icon: '📶', color: '#00C2A8',
      description: 'A wireless network',
      properties: {
        ssid: { type: 'string', label: 'SSID', required: true, searchable: true, pii: false, embed: true },
        bssid: { type: 'string', label: 'BSSID', required: false, searchable: true, pii: false, embed: false },
        security: { type: 'string', label: 'Security Type', required: false, searchable: true, pii: false, embed: false },
        frequency: { type: 'string', label: 'Frequency', required: false, searchable: false, pii: false, embed: false },
      },
    },
    {
      type: 'event', domain: 'EVENT', label: 'Event', icon: '📅', color: '#F2A65A',
      description: 'A notable event or incident',
      properties: {
        eventType: { type: 'string', label: 'Event Type', required: true, searchable: true, pii: false, embed: false },
        date: { type: 'date', label: 'Date', required: false, searchable: true, pii: false, embed: false },
        participants: { type: 'string[]', label: 'Participants', required: false, searchable: true, pii: true, embed: false },
        description: { type: 'string', label: 'Description', required: false, searchable: true, pii: false, embed: true },
      },
    },
    {
      type: 'image_media', domain: 'MEDIA', label: 'Image / Media', icon: '🖼️', color: '#9B9B9B',
      description: 'An image or media file containing intelligence',
      properties: {
        source: { type: 'string', label: 'Source', required: false, searchable: true, pii: false, embed: false },
        url: { type: 'string', label: 'URL', required: false, searchable: false, pii: false, embed: false },
        faces: { type: 'number', label: 'Faces Detected', required: false, searchable: false, pii: false, embed: false },
        textExtracted: { type: 'string', label: 'Extracted Text', required: false, searchable: true, pii: false, embed: true },
      },
    },
  ];
}

export function getFallbackLinkTypes(): LinkType[] {
  return [
    { type: 'owns', label: 'Owns', description: 'Person/organization owns this asset', directed: true, sourceTypes: ['person', 'organization'], targetTypes: ['vehicle', 'vessel', 'aircraft', 'network_node'], strength: 0.9 },
    { type: 'registered_to', label: 'Registered To', description: 'Registered to a person or organization', directed: true, sourceTypes: ['*'], targetTypes: ['person', 'organization'], strength: 0.85 },
    { type: 'communicated_with', label: 'Communicated With', description: 'Communication between entities', directed: false, sourceTypes: ['*'], targetTypes: ['*'], strength: 0.8 },
    { type: 'located_at', label: 'Located At', description: 'Located at a place', directed: true, sourceTypes: ['*'], targetTypes: ['place'], strength: 0.9 },
    { type: 'sighted_at', label: 'Sighted At', description: 'Sighted at a location or event', directed: true, sourceTypes: ['person', 'vehicle', 'vessel'], targetTypes: ['place', 'event'], strength: 0.7 },
    { type: 'member_of', label: 'Member Of', description: 'Membership in an organization', directed: true, sourceTypes: ['person'], targetTypes: ['organization'], strength: 0.9 },
    { type: 'mentioned_in', label: 'Mentioned In', description: 'Mentioned in a media or event', directed: true, sourceTypes: ['*'], targetTypes: ['media', 'event'], strength: 0.6 },
    { type: 'same_as', label: 'Same As', description: 'Duplicate/fuzzy match resolution', directed: false, sourceTypes: ['*'], targetTypes: ['*'], strength: 0.95 },
  ];
}
