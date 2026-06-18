#!/bin/bash
# ═══════════════════════════════════════════════════════════
# OSIRIS — Seed Ontology Simulation Data
# Seeds 17 entities + relationships into the server API.
# Run after server restart when in-memory store is empty.
# Usage: bash scripts/seed-ontology-data.sh
# ═══════════════════════════════════════════════════════════

BASE_URL="${1:-http://192.168.0.173:3000}"

echo "Seeding ontology data at $BASE_URL..."

# Batch entities
curl -s -X POST "$BASE_URL/api/ontology/entities" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "batch",
    "entities": [
      {"id":"person-001","type":"person","domain":"PERSON","label":"Viktor Petrov","description":"Russian oligarch with connections to Eastern European cyber operations","properties":{"fullName":"Viktor Aleksandrovich Petrov","phone":"+7-495-555-0147"},"tags":["oligarch","cyber"],"source":"simulation"},
      {"id":"person-002","type":"person","domain":"PERSON","label":"Elena Morozova","description":"Cyber security researcher and intermediary","properties":{"fullName":"Elena Dmitrievna Morozova","phone":"+41-78-632-4489","aliases":["RedBaron"]},"tags":["researcher","cyber"],"source":"simulation"},
      {"id":"person-003","type":"person","domain":"PERSON","label":"Marcus Chen","description":"Taiwanese intelligence liaison","properties":{"fullName":"Marcus Wei Chen","email":"mchen@alumni.nthu.edu.tw"},"tags":["intelligence"],"source":"simulation"},
      {"id":"phone-001","type":"phone_number","domain":"COMMUNICATION","label":"Petrov Burner","description":"Burner phone Cyprus","properties":{"number":"+357-99-123-4567","contactName":"Viktor Petrov"},"tags":["burner","cyprus"],"source":"simulation"},
      {"id":"phone-002","type":"phone_number","domain":"COMMUNICATION","label":"Morozova Swiss Line","description":"Swiss mobile","properties":{"number":"+41-22-555-3391"},"tags":["swiss"],"source":"simulation"},
      {"id":"email-001","type":"phone_number","domain":"COMMUNICATION","label":"ProtonMail Bridge","description":"Encrypted coordination","properties":{"number":"bridge@protonmail.ch"},"tags":["encrypted"],"source":"simulation"},
      {"id":"social-001","type":"social_profile","domain":"SOCIAL","label":"@v_petrov TG","description":"Telegram coordination","properties":{"platform":"TG","username":"v_petrov"},"tags":["telegram"],"source":"simulation"},
      {"id":"social-002","type":"social_profile","domain":"SOCIAL","label":"@redbaron Signal","description":"Signal operational","properties":{"platform":"SC","username":"redbaron.42"},"tags":["signal"],"source":"simulation"},
      {"id":"id-001","type":"identity_document","domain":"IDENTITY","label":"Petrov Passport","description":"Russian passport","properties":{"idType":"Passport","idNumber":"RU-785412369"},"tags":["passport"],"source":"simulation"},
      {"id":"id-002","type":"identity_document","domain":"IDENTITY","label":"Morozova Swiss ID","description":"Swiss ID","properties":{"idType":"ID","idNumber":"CH-ID-8847201"},"tags":["swiss-id"],"source":"simulation"},
      {"id":"place-001","type":"place","domain":"LOCATION","label":"Moscow Office","description":"Moscow business district","coordinates":{"lat":55.7497,"lng":37.5395},"properties":{"country":"Russia"},"tags":["moscow"],"source":"simulation"},
      {"id":"place-002","type":"place","domain":"LOCATION","label":"Geneva Safe House","description":"Geneva meetings","coordinates":{"lat":46.2044,"lng":6.1432},"properties":{"country":"Switzerland"},"tags":["geneva"],"source":"simulation"},
      {"id":"place-003","type":"place","domain":"LOCATION","label":"Taipei Office","description":"Taipei diplomatic mission","coordinates":{"lat":25.033,"lng":121.5654},"properties":{"country":"Taiwan"},"tags":["taipei"],"source":"simulation"},
      {"id":"event-001","type":"event","domain":"EVENT","label":"Geneva Meetup","description":"Petrov-Morozova meeting","coordinates":{"lat":46.2044,"lng":6.1432},"properties":{"eventType":"Meeting","date":"2026-03-14"},"tags":["meeting"],"source":"simulation"},
      {"id":"event-002","type":"event","domain":"EVENT","label":"Taipei Conference","description":"Cyber security conference","coordinates":{"lat":25.033,"lng":121.5654},"properties":{"eventType":"Conference","date":"2026-04-01"},"tags":["conference"],"source":"simulation"},
      {"id":"vehicle-001","type":"vehicle","domain":"VEHICLE","label":"Petrov Mercedes","description":"Armoured S-Class","properties":{"plate":"M777VP","make":"Mercedes-Benz","model":"S-580 Guard"},"tags":["armoured"],"source":"simulation"},
      {"id":"media-001","type":"image_media","domain":"MEDIA","label":"Geneva CCTV","description":"CCTV from safe house","properties":{"source":"Geneva CCTV","textExtracted":"Two persons enter building"},"tags":["cctv"],"source":"simulation"}
    ]
  }' | python3 -m json.tool

# Relationships
echo "Creating relationships..."
for rel in \
  "person-001 phone-001 owns 0.95" \
  "person-002 phone-002 owns 0.90" \
  "person-001 person-002 communicated_with 0.85" \
  "person-001 social-001 owns 0.90" \
  "person-002 social-002 owns 0.90" \
  "id-001 person-001 registered_to 1.00" \
  "id-002 person-002 registered_to 1.00" \
  "person-001 place-001 located_at 0.80" \
  "person-002 place-002 located_at 0.75" \
  "person-003 place-003 located_at 0.85" \
  "person-001 event-001 sighted_at 0.90" \
  "person-002 event-001 sighted_at 0.90" \
  "person-003 event-002 sighted_at 0.85" \
  "place-002 media-001 mentioned_in 0.80" \
  "person-001 vehicle-001 owns 0.95" \
  "vehicle-001 place-001 located_at 0.70" \
  "phone-001 phone-002 communicated_with 0.70" \
  "person-001 email-001 owns 0.80" \
  "person-002 email-001 owns 0.80"; do

  set -- $rel
  curl -s -X POST "$BASE_URL/api/ontology/entities" \
    -H "Content-Type: application/json" \
    -d "{\"action\":\"relate\",\"sourceId\":\"$1\",\"targetId\":\"$2\",\"label\":\"$3\",\"strength\":$4}" > /dev/null
done
echo "19 relationships created."

# Cross-reference
echo "Running cross-reference..."
curl -s -X POST "$BASE_URL/api/ontology/entities" \
  -H "Content-Type: application/json" \
  -d '{"action":"cross-reference"}' | python3 -c "import sys,json;d=json.load(sys.stdin);print(f'{d.get(\"count\",0)} cross-reference links created')"

# Verify
echo ""
echo "=== Verification ==="
curl -s "$BASE_URL/api/ontology/entities?graph=true" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'ONTOLOGY GRAPH: {len(d.get(\"entities\",[]))} entities, {len(d.get(\"relationships\",[]))} relationships')
print(f'Entities by type:')
types = {}
for e in d.get('entities',[]):
    t = e.get('type','unknown')
    types[t] = types.get(t,0) + 1
for t,c in sorted(types.items()):
    print(f'  {t}: {c}')
"
