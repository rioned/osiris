#!/usr/bin/env python3
"""
OSIRIS — Synthetic Data Generator for Social Media Connectors
Generates 1000+ realistic synthetic entries for each connector:
  - Twitter (X)   : tweets, profiles, followers, threads
  - YouTube        : channels, videos, comments
  - Facebook       : pages, posts, comments, groups
  - LinkedIn       : profiles, posts, companies, comments
  - WhatsApp       : chat exports, media logs
  - Bulk Importer  : person IDs, phone contacts, persons & jobs

Output: JSON files in /home/lab/osiris/data/synthetic/
"""

import json
import random
import datetime
import os
import itertools

random.seed(42)

OUTPUT_DIR = "/home/lab/osiris/data/synthetic"
os.makedirs(OUTPUT_DIR, exist_ok=True)

# ── Shared data pools ──────────────────────────────────────────

FIRST_NAMES = [
    "James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael", "Linda",
    "David", "Elizabeth", "William", "Barbara", "Richard", "Susan", "Joseph", "Jessica",
    "Thomas", "Sarah", "Christopher", "Karen", "Daniel", "Nancy", "Matthew", "Lisa",
    "Anthony", "Betty", "Mark", "Margaret", "Donald", "Sandra", "Steven", "Ashley",
    "Andrew", "Kimberly", "Paul", "Emily", "Joshua", "Donna", "Kenneth", "Michelle",
    "Kevin", "Carol", "Brian", "Amanda", "George", "Melissa", "Timothy", "Deborah",
    "Ronald", "Stephanie", "Edward", "Dorothy", "Jason", "Rebecca", "Jeffrey", "Sharon",
    "Ryan", "Laura", "Jacob", "Cynthia", "Gary", "Kathleen", "Nicholas", "Amy",
    "Eric", "Angela", "Jonathan", "Shirley", "Stephen", "Anna", "Larry", "Brenda",
    "Justin", "Pamela", "Scott", "Emma", "Brandon", "Nicole", "Benjamin", "Helen",
    "Samuel", "Samantha", "Raymond", "Katherine", "Gregory", "Christine", "Frank", "Debra",
    "Alexander", "Rachel", "Patrick", "Carolyn", "Jack", "Janet", "Dennis", "Catherine",
    "Jerry", "Maria", "Tyler", "Heather", "Aaron", "Diane"
]

LAST_NAMES = [
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
    "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson",
    "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson",
    "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson", "Walker",
    "Young", "Allen", "King", "Wright", "Scott", "Torres", "Nguyen", "Hill",
    "Flores", "Green", "Adams", "Nelson", "Baker", "Hall", "Rivera", "Campbell",
    "Mitchell", "Carter", "Roberts", "Gomez", "Phillips", "Evans", "Turner", "Diaz",
    "Parker", "Cruz", "Edwards", "Collins", "Reyes", "Stewart", "Morris", "Morales",
    "Murphy", "Cook", "Rogers", "Gutierrez", "Ortiz", "Morgan", "Cooper", "Peterson",
    "Bailey", "Reed", "Kelly", "Howard", "Ramos", "Kim", "Cox", "Ward",
    "Richardson", "Watson", "Brooks", "Chavez", "Wood", "James", "Bennett", "Gray",
    "Mendoza", "Ruiz", "Hughes", "Price", "Alvarez", "Castillo", "Sanders", "Patel",
    "Myers", "Long", "Ross", "Foster", "Jimenez"
]

CITIES = [
    "New York", "Los Angeles", "Chicago", "Houston", "Phoenix", "Philadelphia",
    "San Antonio", "San Diego", "Dallas", "San Jose", "Austin", "Jacksonville",
    "Fort Worth", "Columbus", "Charlotte", "Indianapolis", "San Francisco", "Seattle",
    "Denver", "Nashville", "Oklahoma City", "El Paso", "Washington", "Boston",
    "Las Vegas", "Portland", "Memphis", "Louisville", "Baltimore", "Milwaukee",
    "Albuquerque", "Tucson", "Fresno", "Sacramento", "Mesa", "Atlanta", "Kansas City",
    "Omaha", "Colorado Springs", "Raleigh", "Long Beach", "Virginia Beach", "Miami",
    "Oakland", "Minneapolis", "Tampa", "Tulsa", "Arlington", "New Orleans", "Cleveland"
]

COUNTRIES = [
    "United States", "United Kingdom", "Canada", "Australia", "Germany", "France",
    "Brazil", "India", "Japan", "South Korea", "Singapore", "Netherlands",
    "Sweden", "Norway", "Denmark", "Finland", "Ireland", "Switzerland", "Italy",
    "Spain", "Mexico", "Argentina", "Colombia", "Chile", "South Africa", "Egypt",
    "Kenya", "Nigeria", "New Zealand", "Israel", "UAE", "Saudi Arabia"
]

COMPANIES = [
    "Acme Corp", "Global Industries", "TechVision Inc", "Quantum Dynamics",
    "Apex Solutions", "Nova Systems", "Infinity Labs", "Cascade Technologies",
    "Vertex Global", "Matrix Innovations", "Omega Enterprises", "Strata Inc",
    "Fusion Dynamics", "Prime Networks", "Elite Software", "Core Systems",
    "Vanguard Tech", "Pacific Group", "Summit Solutions", "Apex Digital",
    "NorthStar Analytics", "Ironwood Systems", "Pine Street Capital",
    "Hudson River Tech", "Meridian Global", "Atlas Corporation",
    "Orion Research", "Sapphire Systems", "Titan Industries", "Catalyst Labs"
]

JOB_TITLES = [
    "CEO", "CTO", "CFO", "VP Engineering", "VP Sales", "Director of Operations",
    "Software Engineer", "Senior Developer", "Product Manager", "Data Scientist",
    "Marketing Manager", "Sales Director", "HR Manager", "Business Analyst",
    "Security Analyst", "Network Engineer", "DevOps Lead", "QA Engineer",
    "UX Designer", "Technical Writer", "Customer Success Manager",
    "Financial Analyst", "Legal Counsel", "Research Scientist", "Account Manager",
    "Chief Architect", "VP Product", "Head of Design", "Operations Manager",
    "Cloud Architect", "Data Engineer", "Compliance Officer"
]

HASHTAGS = [
    "#tech", "#ai", "#blockchain", "#cybersecurity", "#data", "#cloud",
    "#innovation", "#startup", "#digital", "#future", "#coding", "#programming",
    "#opensource", "#devops", "#ml", "#analytics", "#business", "#growth",
    "#security", "#privacy", "#iot", "#bigdata", "#saas", "#fintech",
    "#healthtech", "#edtech", "#greentech", "#autonomous", "#robotics", "#web3",
    "#defi", "#nft", "#metaverse", "#remotework", "#hybridwork", "#leadership"
]

TOPICS = [
    "artificial intelligence", "machine learning", "data science", "cloud computing",
    "cybersecurity trends", "digital transformation", "remote work", "blockchain",
    "sustainable energy", "quantum computing", "edge computing", "5G technology",
    "autonomous vehicles", "smart cities", "biotechnology", "space exploration",
    "renewable energy", "supply chain innovation", "financial technology",
    "healthcare technology", "education technology", "agricultural tech",
    "cyber threat intelligence", "open source software", "API development",
    "microservices architecture", "containerization", "DevOps culture",
    "UI/UX design", "product management", "data privacy", "regulatory compliance"
]

def rand_date(start_year=2018, end_year=2026):
    start = datetime.date(start_year, 1, 1)
    end = datetime.date(end_year, 12, 31)
    delta = (end - start).days
    d = start + datetime.timedelta(days=random.randint(0, delta))
    return d.isoformat()

def rand_datetime(start_year=2018, end_year=2026):
    start = datetime.datetime(start_year, 1, 1, 0, 0, 0)
    end = datetime.datetime(end_year, 12, 31, 23, 59, 59)
    delta = (end - start).total_seconds()
    d = start + datetime.timedelta(seconds=random.randint(0, int(delta)))
    return d.strftime("%Y-%m-%dT%H:%M:%S.000Z")

def pick_name():
    return f"{random.choice(FIRST_NAMES)} {random.choice(LAST_NAMES)}"

def pick_username():
    first = random.choice(FIRST_NAMES).lower()
    last = random.choice(LAST_NAMES).lower()
    suffix = random.randint(1, 9999)
    return f"{first}{last}{suffix}"

def pick_email(name=None):
    if name is None:
        name = pick_name()
    parts = name.lower().split()
    domain = random.choice(["gmail.com", "outlook.com", "proton.me", "icloud.com", "yahoo.com", "company.com", "corp.net"])
    return f"{parts[0]}.{parts[1]}@{domain}"

def pick_phone():
    return f"+1-{random.randint(200,999)}-{random.randint(100,999)}-{random.randint(1000,9999)}"

def pick_bio():
    templates = [
        "{} | {} enthusiast | Thoughts are my own",
        "Working on {} | {}",
        "Building things at the intersection of {} and {}",
        "{} professional. {} believer.",
        "Exploring {}. Life is a journey.",
        "Passionate about {} and {}. Tweets about tech & life.",
        "{} | {} | Coffee addict",
        "Just here for the memes and {} news.",
    ]
    t = random.choice(templates)
    args = [random.choice(TOPICS) for _ in range(t.count("{}"))]
    return t.format(*args).capitalize()

def pick_tweet_text():
    templates = [
        "Just published a deep dive on {}. Check it out! #tech #insights",
        "Interesting take on {} today. The industry is changing fast.",
        "Can't believe how much {} has evolved in the last year. Game changer.",
        "Thread: Why {} matters more than ever. A quick breakdown...",
        "New blog post: {} in 2025 — what you need to know.",
        "Hot take: The future of {} is bright. Here's why...",
        "Working on something exciting at the intersection of {} and {}.",
        "Just attended an amazing conference on {}. Key takeaways...",
        "My team just shipped something huge. {} platform v2 is live!",
        "Great discussion on {} over coffee this morning. Food for thought.",
        "The landscape of {} is shifting. Are you ready?",
        "I've been saying this for years: {} will transform everything.",
        "Impressed by the latest advances in {}. The pace is incredible.",
        "New research on {} just dropped. Must read for anyone in the field.",
        "Excited to share my latest project: {}. Built with {}.",
        "Spent the weekend diving deep into {}. Some thoughts...",
        "The impact of {} on society cannot be overstated. We need to talk about this.",
        "Every {} practitioner should understand these fundamentals.",
        "Just wrapped up a major {} deployment. Lessons learned thread incoming.",
        "Interesting patterns emerging in {} data this quarter. Analysis below.",
    ]
    t = random.choice(templates)
    args = [random.choice(TOPICS) for _ in range(t.count("{}"))]
    return t.format(*args)

# ══════════════════════════════════════════════════════════════════
# 1. TWITTER (X) SYNTHETIC DATA — 1000 entries
# ══════════════════════════════════════════════════════════════════

def generate_twitter_data(count=1000):
    profiles = []
    tweets = []
    followers = []
    
    for i in range(count):
        name = pick_name()
        username = pick_username()
        bio = pick_bio()
        location = f"{random.choice(CITIES)}, {random.choice(COUNTRIES)}"
        joined = rand_date(2008, 2024)
        
        profile = {
            "id": f"twitter_user_{i+1}",
            "username": username,
            "displayName": name,
            "bio": bio,
            "location": location,
            "website": f"https://{username}.com" if random.random() > 0.3 else "",
            "followers": random.randint(50, 500000),
            "following": random.randint(20, 5000),
            "tweetCount": random.randint(100, 50000),
            "joined": joined,
            "verified": random.random() > 0.85,
            "profileImage": f"https://pbs.twimg.com/profile_images/{random.randint(1000000,9999999)}.jpg",
            "headerImage": f"https://pbs.twimg.com/profile_banners/{random.randint(1000000,9999999)}",
        }
        profiles.append(profile)
        
        # 2-5 tweets per user
        for j in range(random.randint(2, 5)):
            tweet = {
                "id": f"tweet_{i}_{j}",
                "author": username,
                "authorDisplayName": name,
                "text": pick_tweet_text(),
                "createdAt": rand_datetime(2020, 2026),
                "likes": random.randint(0, 5000),
                "retweets": random.randint(0, 1000),
                "replies": random.randint(0, 200),
                "views": random.randint(100, 100000),
                "lang": "en",
                "isReply": random.random() > 0.7,
                "isRetweet": random.random() > 0.8,
                "hashtags": random.sample(HASHTAGS, random.randint(1, 4)),
                "mentions": [pick_username() for _ in range(random.randint(0, 3))],
                "media": [{"type": random.choice(["photo","video"]), "url": f"https://pbs.twimg.com/media/{random.randint(1000000,9999999)}.jpg"}] if random.random() > 0.5 else [],
                "source": random.choice(["Twitter for iPhone", "Twitter for Android", "Twitter Web App", "TweetDeck", "Buffer"]),
                "geo": {"place_id": f"place_{random.randint(1,10000)}"} if random.random() > 0.7 else None,
            }
            tweets.append(tweet)
        
        # 1 follower relationship per profile
        follower = {
            "id": f"follower_{i+1}",
            "username": pick_username(),
            "displayName": pick_name(),
            "bio": pick_bio(),
            "followers": random.randint(10, 10000),
            "following": random.randint(5, 2000),
            "location": f"{random.choice(CITIES)}, {random.choice(COUNTRIES)}",
            "joined": rand_date(2008, 2024),
            "verified": random.random() > 0.9,
            "followedBy": username,
        }
        followers.append(follower)
    
    return {"profiles": profiles, "tweets": tweets, "followers": followers}


# ══════════════════════════════════════════════════════════════════
# 2. YOUTUBE SYNTHETIC DATA — 1000 entries
# ══════════════════════════════════════════════════════════════════

def generate_youtube_data(count=1000):
    channels = []
    
    for i in range(count):
        channel_name = pick_name() if random.random() > 0.3 else random.choice(COMPANIES)
        channel_id = f"UC{random.randint(10000000000,99999999999)}"
        
        videos = []
        for j in range(random.randint(5, 20)):
            video = {
                "id": f"vid_{i}_{j}",
                "title": f"{random.choice(['How to', 'Why', 'The Future of', 'Understanding', 'Deep Dive into', 'Complete Guide to', 'Top 10', 'Review:'])} {random.choice(TOPICS)}",
                "description": f"In this video, we explore {random.choice(TOPICS)} and its implications for {random.choice(TOPICS)}. #tech #tutorial",
                "publishedAt": rand_datetime(2018, 2026),
                "duration": f"PT{random.randint(5, 60)}M{random.randint(0, 59)}S",
                "viewCount": random.randint(1000, 5000000),
                "likeCount": random.randint(50, 200000),
                "commentCount": random.randint(5, 10000),
                "tags": random.sample(HASHTAGS, random.randint(2, 5)),
                "categoryId": str(random.randint(1, 44)),
                "defaultLanguage": "en",
                "thumbnailUrl": f"https://i.ytimg.com/vi/{channel_id}/hqdefault.jpg",
            }
            videos.append(video)
        
        comments = []
        for k in range(random.randint(10, 30)):
            comment = {
                "id": f"comment_{i}_{k}",
                "authorDisplayName": pick_name(),
                "authorChannelId": f"UC{random.randint(10000000000,99999999999)}",
                "textDisplay": f"Great video! I really appreciate the breakdown of {random.choice(TOPICS)}. Looking forward to more content like this.",
                "publishedAt": rand_datetime(2020, 2026),
                "likeCount": random.randint(0, 500),
                "replies": [
                    {
                        "authorDisplayName": pick_name(),
                        "textDisplay": f"Thanks for watching! Glad you found it helpful.",
                        "publishedAt": rand_datetime(2020, 2026),
                        "likeCount": random.randint(0, 50),
                    } for _ in range(random.randint(0, 5))
                ]
            }
            comments.append(comment)
        
        channel = {
            "channelId": channel_id,
            "title": f"{channel_name} {'Official' if random.random() > 0.5 else 'Tech'}",
            "description": f"Welcome to the official YouTube channel of {channel_name}. We cover {random.choice(TOPICS)}, {random.choice(TOPICS)}, and everything in between. Subscribe for regular updates!",
            "subscriberCount": random.randint(100, 5000000),
            "videoCount": len(videos),
            "viewCount": sum(v["viewCount"] for v in videos),
            "country": random.choice(COUNTRIES),
            "joinedDate": rand_date(2010, 2020),
            "customUrl": f"@{channel_name.lower().replace(' ', '')}",
            "keywords": random.sample(TOPICS, random.randint(3, 8)),
            "verified": random.random() > 0.7,
            "videos": videos,
            "comments": comments,
        }
        channels.append(channel)
    
    return {"channels": channels}


# ══════════════════════════════════════════════════════════════════
# 3. FACEBOOK SYNTHETIC DATA — 1000 entries
# ══════════════════════════════════════════════════════════════════

def generate_facebook_data(count=1000):
    pages = []
    
    for i in range(count):
        page_name = random.choice(COMPANIES) if random.random() > 0.4 else pick_name()
        page_id = f"fb_page_{i+1}"
        
        posts = []
        for j in range(random.randint(3, 10)):
            post = {
                "id": f"fb_post_{i}_{j}",
                "message": f"Exciting news! We're thrilled to announce our latest initiative in {random.choice(TOPICS)}. Stay tuned for more updates!",
                "createdAt": rand_datetime(2020, 2026),
                "type": random.choice(["status", "link", "photo", "video", "event"]),
                "reactions": {"like": random.randint(10, 5000), "love": random.randint(0, 500), "wow": random.randint(0, 200), "sad": random.randint(0, 50), "angry": random.randint(0, 20)},
                "shares": random.randint(0, 1000),
                "comments": random.randint(0, 500),
                "link": f"https://fb.com/{page_id}/posts/{random.randint(100000,999999)}" if random.random() > 0.4 else None,
                "mediaUrl": f"https://fb.com/photo/{random.randint(1000000,9999999)}" if random.random() > 0.5 else None,
                "location": f"{random.choice(CITIES)}, {random.choice(COUNTRIES)}" if random.random() > 0.6 else None,
            }
            posts.append(post)
        
        group = {
            "id": f"fb_group_{i+1}",
            "name": f"{random.choice(TOPICS).title()} Enthusiasts",
            "description": f"A community for people passionate about {random.choice(TOPICS)} and {random.choice(TOPICS)}. Join us!",
            "memberCount": random.randint(100, 500000),
            "privacy": random.choice(["public", "closed", "secret"]),
            "createdAt": rand_date(2015, 2024),
        }
        
        page = {
            "pageId": page_id,
            "name": page_name,
            "category": random.choice(["Technology", "Business", "Education", "Entertainment", "News", "Science"]),
            "description": f"Official Facebook page of {page_name}. We share updates about {random.choice(TOPICS)}, {random.choice(TOPICS)}, and industry insights.",
            "likes": random.randint(100, 1000000),
            "followers": random.randint(100, 1000000),
            "website": f"https://{page_name.lower().replace(' ','')}.com",
            "phone": pick_phone(),
            "email": pick_email(page_name),
            "location": f"{random.choice(CITIES)}, {random.choice(COUNTRIES)}",
            "founded": random.randint(2000, 2022),
            "posts": posts,
            "group": group,
        }
        pages.append(page)
    
    return {"pages": pages}


# ══════════════════════════════════════════════════════════════════
# 4. LINKEDIN SYNTHETIC DATA — 1000 entries
# ══════════════════════════════════════════════════════════════════

def generate_linkedin_data(count=1000):
    entries = []
    
    for i in range(count):
        name = pick_name()
        urn = f"urn:li:person:{name.lower().replace(' ','')}{random.randint(100,999)}"
        company = random.choice(COMPANIES)
        title = random.choice(JOB_TITLES)
        
        # Experience entries
        num_exp = random.randint(1, 5)
        experiences = []
        for e in range(num_exp):
            start_year = random.randint(2005 + e*3, 2020 + e)
            end_year = start_year + random.randint(1, 5) if e < num_exp - 1 or random.random() > 0.3 else None
            experiences.append({
                "title": random.choice(JOB_TITLES),
                "company": random.choice(COMPANIES),
                "location": f"{random.choice(CITIES)}, {random.choice(COUNTRIES)}",
                "startDate": f"{start_year}-{random.randint(1,12):02d}",
                "endDate": f"{end_year}-{random.randint(1,12):02d}" if end_year else "Present",
                "description": f"Led initiatives in {random.choice(TOPICS)} and {random.choice(TOPICS)}. Drove significant improvements in operational efficiency."
            })
        
        education_choices = [
            ("MIT", "Computer Science"), ("Stanford", "Business"), ("Harvard", "Law"),
            ("UC Berkeley", "Engineering"), ("Cambridge", "Economics"), ("Oxford", "Philosophy"),
            ("Georgia Tech", "Data Science"), ("Columbia", "Finance"), ("UCLA", "Communications"),
            ("University of Michigan", "Information Systems"), ("NYU", "Marketing"),
            ("Carnegie Mellon", "Robotics"), ("Caltech", "Physics"), ("Princeton", "Mathematics"),
        ]
        edu = random.choice(education_choices)
        
        post_count = random.randint(2, 8)
        posts = []
        for p in range(post_count):
            posts.append({
                "id": f"li_post_{i}_{p}",
                "authorUrn": urn,
                "text": f"I'm excited to share that I've been working on {random.choice(TOPICS)}. The industry is evolving rapidly and I'm proud to be at the forefront. #innovation #technology",
                "publishedAt": rand_datetime(2021, 2026),
                "likes": random.randint(5, 2000),
                "comments": random.randint(0, 200),
                "reposts": random.randint(0, 100),
                "hashtags": random.sample(HASHTAGS, random.randint(1, 4)),
            })
        
        entry = {
            "profileUrn": urn,
            "name": name,
            "headline": f"{title} at {company}",
            "location": f"{random.choice(CITIES)}, {random.choice(COUNTRIES)}",
            "industry": random.choice(["Technology", "Finance", "Healthcare", "Consulting", "Manufacturing", "Energy"]),
            "connections": random.randint(50, 5000),
            "profilePicture": f"https://media.licdn.com/dms/image/{random.randint(1000000,9999999)}",
            "experiences": experiences,
            "education": {"school": edu[0], "degree": random.choice(["Bachelor's", "Master's", "PhD"]), "field": edu[1], "year": random.randint(2000, 2020)},
            "skills": random.sample(["Python", "JavaScript", "AWS", "Leadership", "Strategy", "Data Analysis", "Product Management", "Machine Learning", "Agile", "Kubernetes", "Docker", "Terraform", "Go", "Rust", "React", "Node.js", "TypeScript", "SQL", "NoSQL", "GraphQL"], random.randint(5, 15)),
            "posts": posts,
        }
        entries.append(entry)
    
    # Company entries
    companies = []
    for ci, comp in enumerate(COMPANIES):
        company_urn = f"urn:li:company:{comp.lower().replace(' ','')}"
        company = {
            "companyUrn": company_urn,
            "name": comp,
            "industry": random.choice(["Technology", "Finance", "Healthcare", "Consulting"]),
            "employeeCount": random.randint(50, 50000),
            "description": f"{comp} is a leading provider of {random.choice(TOPICS)} solutions. We serve clients worldwide.",
            "founded": random.randint(1990, 2020),
            "headquarters": f"{random.choice(CITIES)}, {random.choice(COUNTRIES)}",
            "website": f"https://{comp.lower().replace(' ','')}.com",
            "specialties": random.sample(TOPICS, random.randint(3, 8)),
        }
        companies.append(company)
    
    return {"profiles": entries, "companies": companies}


# ══════════════════════════════════════════════════════════════════
# 5. WHATSAPP SYNTHETIC DATA — 1000 entries
# ══════════════════════════════════════════════════════════════════

def generate_whatsapp_data(count=1000):
    chat_exports = []
    
    # Generate 20 chat groups/conversations, each with many messages
    participants_pool = [pick_name() for _ in range(50)]
    
    for chat_id in range(min(count, 50)):
        is_group = random.random() > 0.4
        chat_name = f"{random.choice(TOPICS).title()} Group" if is_group else f"{participants_pool[chat_id % len(participants_pool)]} & {participants_pool[(chat_id+1) % len(participants_pool)]}"
        chat_participants = random.sample(participants_pool, random.randint(2, 15) if is_group else 2)
        
        messages = []
        msg_count = random.randint(20, 50)
        for m in range(msg_count):
            sender = random.choice(chat_participants)
            date = rand_datetime(2022, 2026)
            
            msg_type = random.choices(
                ["text", "media", "system", "location", "call"],
                weights=[0.65, 0.15, 0.1, 0.05, 0.05]
            )[0]
            
            if msg_type == "text":
                text_templates = [
                    "Hey, did you see the latest on {}?",
                    "Meeting at 3pm tomorrow to discuss {}.",
                    "Just sent you the {} report.",
                    "Can you review this {} proposal when you get a chance?",
                    "Great news about the {} project!",
                    "I think we should focus on {} this quarter.",
                    "Any updates on the {} situation?",
                    "Let's circle back on {} after the call.",
                    "The {} deployment went smoothly.",
                    "Who's handling the {} integration?",
                ]
                t = random.choice(text_templates)
                text = t.format(random.choice(TOPICS))
            elif msg_type == "media":
                text = f"<Media omitted: {random.choice(['image','video','document','audio'])}>"
            elif msg_type == "system":
                text = random.choice([
                    f"{pick_name()} added {pick_name()}",
                    f"{pick_name()} left",
                    f"{pick_name()} changed the group name",
                    f"{pick_name()} joined using this group's invite link",
                    "Messages are end-to-end encrypted",
                ])
            elif msg_type == "location":
                text = f"📍 {random.choice(CITIES)}, {random.choice(COUNTRIES)}"
            else:
                text = f"📞 Missed voice call from {sender} · Duration: {random.randint(10,600)}s"
            
            messages.append({
                "id": f"wa_msg_{chat_id}_{m}",
                "sender": sender,
                "text": text,
                "timestamp": date,
                "type": msg_type,
            })
        
        chat_export = {
            "chatId": f"wa_chat_{chat_id}",
            "title": chat_name,
            "isGroup": is_group,
            "participants": chat_participants,
            "messageCount": len(messages),
            "dateRange": {"from": messages[0]["timestamp"], "to": messages[-1]["timestamp"]},
            "messages": messages,
        }
        chat_exports.append(chat_export)
    
    # Media logs
    media_logs = []
    for mi in range(count):
        participant = random.choice(participants_pool)
        media_logs.append({
            "id": f"wa_media_{mi}",
            "fileName": f"IMG_{rand_datetime(2022,2026).replace(':','').replace('-','').replace('T','_').split('.')[0]}.jpg",
            "fileType": random.choice(["image/jpeg", "video/mp4", "audio/ogg", "application/pdf"]),
            "fileSize": random.randint(10000, 50000000),
            "sender": participant,
            "timestamp": rand_datetime(2022, 2026),
            "chatTitle": random.choice([c["title"] for c in chat_exports]),
            "mediaType": random.choice(["photo", "video", "audio", "document"]),
        })
    
    return {"chatExports": chat_exports, "mediaLogs": media_logs}


# ══════════════════════════════════════════════════════════════════
# 6. BULK IMPORTER SYNTHETIC DATA — 1000+ entries
# ══════════════════════════════════════════════════════════════════

def generate_bulk_import_data(count=1000):
    # Person IDs
    person_ids = []
    for i in range(count):
        name = pick_name()
        person_ids.append({
            "person_name": name,
            "id_type": random.choice(["Passport", "Driver License", "National ID", "Social Security", "Residence Permit"]),
            "id_number": f"{random.choice(['AB','CD','EF','GH','JK','LM'])}{random.randint(100000,999999)}",
            "country": random.choice(COUNTRIES),
            "dob": rand_date(1960, 2005),
            "nationality": random.choice(COUNTRIES),
            "notes": random.choice(["Subject of interest", "Previous investigation", "Cross-border activity", "Financial nexus point", "", ""]),
        })
    
    # Phone contacts
    phone_contacts = []
    for i in range(count):
        name = pick_name()
        phone_contacts.append({
            "contact_name": name,
            "phone_number": pick_phone(),
            "email": pick_email(name),
            "address": f"{random.randint(1,9999)} {random.choice(['Main','Oak','Elm','Park','Lake','River'])} St",
            "city": random.choice(CITIES),
            "country": random.choice(COUNTRIES),
            "organization": random.choice(COMPANIES) if random.random() > 0.3 else "",
            "notes": random.choice(["Supplier contact", "Client reference", "Industry peer", "Conference contact", "", ""]),
        })
    
    # Persons & Jobs
    persons_jobs = []
    managers = [pick_name() for _ in range(20)]
    for i in range(count):
        name = pick_name()
        persons_jobs.append({
            "person_name": name,
            "job_title": random.choice(JOB_TITLES),
            "company": random.choice(COMPANIES),
            "department": random.choice(["Engineering", "Sales", "Marketing", "Finance", "Operations", "HR", "Legal", "Research"]),
            "email": pick_email(name),
            "phone": pick_phone(),
            "linkedin": f"linkedin.com/in/{name.lower().replace(' ','')}",
            "location": f"{random.choice(CITIES)}, {random.choice(COUNTRIES)}",
            "reports_to": random.choice(managers),
            "notes": random.choice(["Executive team", "Key decision maker", "Technical lead", "Regional director", "", ""]),
        })
    
    return {
        "person_ids": person_ids,
        "phone_contacts": phone_contacts,
        "persons_and_jobs": persons_jobs,
    }


# ══════════════════════════════════════════════════════════════════
# WRITE ALL DATA FILES
# ══════════════════════════════════════════════════════════════════

def write_json(filename, data):
    path = os.path.join(OUTPUT_DIR, filename)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    size_kb = os.path.getsize(path) / 1024
    print(f"  ✓ {filename} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    print("OSIRIS Synthetic Data Generator\n")
    print(f"Output: {OUTPUT_DIR}\n")
    
    print("1. Twitter (X) data...")
    twitter = generate_twitter_data(1000)
    write_json("twitter_data.json", twitter)
    print(f"   Profiles: {len(twitter['profiles'])}, Tweets: {len(twitter['tweets'])}, Followers: {len(twitter['followers'])}")
    
    print("\n2. YouTube data...")
    youtube = generate_youtube_data(1000)
    write_json("youtube_data.json", youtube)
    total_videos = sum(len(c["videos"]) for c in youtube["channels"])
    total_comments = sum(len(c["comments"]) for c in youtube["channels"])
    print(f"   Channels: {len(youtube['channels'])}, Videos: {total_videos}, Comments: {total_comments}")
    
    print("\n3. Facebook data...")
    facebook = generate_facebook_data(1000)
    write_json("facebook_data.json", facebook)
    total_posts = sum(len(p["posts"]) for p in facebook["pages"])
    print(f"   Pages: {len(facebook['pages'])}, Posts: {total_posts}")
    
    print("\n4. LinkedIn data...")
    linkedin = generate_linkedin_data(1000)
    write_json("linkedin_data.json", linkedin)
    total_posts = sum(len(p["posts"]) for p in linkedin["profiles"])
    print(f"   Profiles: {len(linkedin['profiles'])}, Companies: {len(linkedin['companies'])}, Posts: {total_posts}")
    
    print("\n5. WhatsApp data...")
    whatsapp = generate_whatsapp_data(1000)
    write_json("whatsapp_data.json", whatsapp)
    total_msgs = sum(c["messageCount"] for c in whatsapp["chatExports"])
    print(f"   Chats: {len(whatsapp['chatExports'])}, Messages: {total_msgs}, Media Logs: {len(whatsapp['mediaLogs'])}")
    
    print("\n6. Bulk Importer data...")
    bulk = generate_bulk_import_data(1000)
    write_json("bulk_import_data.json", bulk)
    print(f"   Person IDs: {len(bulk['person_ids'])}, Phone Contacts: {len(bulk['phone_contacts'])}, Persons & Jobs: {len(bulk['persons_and_jobs'])}")
    
    print("\n✓ All synthetic data generated successfully!")
    print(f"  Total files: 6")
    print(f"  Location: {OUTPUT_DIR}")
