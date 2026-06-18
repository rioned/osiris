#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# OSIRIS — Full Ontology Restore
# 1. Seeds 17 entities + relationships into the server API
# 2. Pushes the data into the browser's localStorage for the personal graph
#
# Usage:
#   1) First run: bash scripts/seed-ontology-data.sh
#   2) Then in the browser console, paste the output of:
#      bash scripts/seed-ontology-full.sh
# ═══════════════════════════════════════════════════════════════════

BASE_URL="${1:-http://192.168.0.173:3000}"

echo "=== Step 1: Seed server API ==="
bash "$(dirname "$0")/seed-ontology-data.sh" "$BASE_URL" 2>&1 | tail -5

echo ""
echo "=== Step 2: Browser injection ==="
echo "After logging in as admin, run this in the browser console:"
echo ""
echo "fetch('/api/ontology/entities?graph=true').then(r=>r.json()).then(d=>{"
echo "  var uid=JSON.parse(localStorage.getItem('osiris_auth_user')||'{}').id;"
echo "  if(!uid){console.error('Not logged in');return;}"
echo "  var sk='osiris_personal_graph:'+uid;"
echo "  var s={"
echo "    entities:d.entities.map(function(e){return{"
echo "      id:e.id,type:e.type,domain:e.domain,label:e.label,"
echo "      description:e.description||'',coordinates:e.coordinates||null,"
echo "      properties:e.properties||{},tags:e.tags||[],source:e.source||'api',"
echo "      linkedEntityIds:e.linkedEntityIds||[],"
echo "      createdAt:e.createdAt||e.created_at||new Date().toISOString(),"
echo "      updatedAt:e.updatedAt||e.updated_at||new Date().toISOString()"
echo "    }}),"
echo "    relationships:(d.relationships||[]).map(function(r){return{"
echo "      id:r.id,sourceId:r.sourceId||r.source_id,"
echo "      targetId:r.targetId||r.target_id,label:r.label,"
echo "      strength:r.strength||0.8,metadata:r.metadata||{},"
echo "      createdAt:r.createdAt||r.created_at||new Date().toISOString()"
echo "    }}),version:2"
echo "  };"
echo "  localStorage.setItem(sk,JSON.stringify(s));"
echo "  console.log('STORED:',s.entities.length,'entities,',s.relationships.length,'relationships');"
echo "  location.reload();"
echo "}).catch(function(e){console.error('FAILED:',e)});"
