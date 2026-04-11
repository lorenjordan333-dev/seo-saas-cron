const Anthropic = require("@anthropic-ai/sdk");
const http = require("http");

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SAAS_SUPABASE_URL = "https://dgrvojmeztdkoorljwrk.supabase.co";
const SAAS_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRncnZvam1lenRka29vcmxqd3JrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MzE1MzYsImV4cCI6MjA5MTQwNzUzNn0.Gs32Z4cOEJsxiDARRIZs2i9SAQ-LunnECXmrt9F46ZE";

function generateSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim() + "-" + Date.now();
}

async function getAllClients() {
  const response = await fetch(`${SAAS_SUPABASE_URL}/functions/v1/get-all-clients`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "apikey": SAAS_ANON_KEY,
    },
  });
  const data = await response.json();
  console.log(`Fetched ${(data.clients || []).length} clients`);
  return data.clients || [];
}

async function markKeywordUsed(keywordId) {
  const response = await fetch(`${SAAS_SUPABASE_URL}/functions/v1/mark-keyword-used`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SAAS_ANON_KEY,
    },
    body: JSON.stringify({ keyword_id: keywordId }),
  });
  const data = await response.json();
  console.log("Keyword marked used:", keywordId, data);
}

async function publishPost(post) {
  const response = await fetch(`${SAAS_SUPABASE_URL}/functions/v1/publish-post`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SAAS_ANON_KEY,
    },
    body: JSON.stringify(post),
  });
  const data = await response.json();
  console.log("Post published:", data);
  return data;
}

async function generateArticle(client, keyword, areaUrl) {
  console.log(`Generating article for ${client.name || client.id} - keyword: "${keyword}"`);

  const prompt = `You are an expert SEO content writer specializing in local businesses.

Write a high-ranking, conversion-optimized SEO article for a ${client.business_type} business located in ${client.location}, targeting this keyword: "${keyword}"

Website: ${client.website_url}

RULES:
- Do NOT include <html>, <head>, <body> tags
- Do NOT wrap content in markdown code fences
- Start directly with an <h1> tag
- Output clean HTML only
- Write content relevant to ${client.business_type} business specifically

INTERNAL LINKS — include these naturally:
- Keyword link: <a href="${areaUrl}">${keyword}</a>
- Website link: <a href="${client.website_url}">${client.business_type} in ${client.location}</a>
- Contact link: <a href="${client.website_url}/contact">contact us</a>

ARTICLE STRUCTURE (MANDATORY):
1. H1 title — include keyword + strong intent
2. Intro — speak to customer's situation, mention location naturally
3. Main service explanation — what the business offers, why choose them
4. Services sections (H2 headings) — break down the main services offered
5. Mid-article CTA — encourage the reader to get in touch
6. Why choose us section — key benefits and differentiators
7. Areas we serve — mention nearby areas and locations naturally
8. End CTA — strong call to action
9. FAQ section — minimum 3 relevant questions with clear answers

SEO RULES:
- 900–1100 words minimum
- Use main keyword 4–6 times naturally
- Use local variations and related terms
- No keyword stuffing
- Natural, human tone

After the HTML content add:
META_TITLE: [max 60 chars, include keyword]
META_DESCRIPTION: [max 155 chars, include keyword and location]`;

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });

  const fullResponse = message.content[0].text;

  const metaTitleMatch = fullResponse.match(/META_TITLE:\s*(.+)/);
  const metaDescMatch = fullResponse.match(/META_DESCRIPTION:\s*(.+)/);

  const metaTitle = metaTitleMatch ? metaTitleMatch[1].trim() : `${keyword} - ${client.business_type} in ${client.location}`;
  const metaDescription = metaDescMatch ? metaDescMatch[1].trim() : `Professional ${client.business_type} services in ${client.location}. ${keyword} — contact us today.`;

  const htmlContent = fullResponse.split(/META_TITLE:/)[0].trim();
  const titleMatch = htmlContent.match(/<h1[^>]*>([^<]+)<\/h1>/);
  const title = titleMatch ? titleMatch[1] : `${keyword} - ${client.business_type} in ${client.location}`;

  return {
    client_id: client.id,
    title,
    slug: generateSlug(title),
    content: htmlContent,
    meta_description: metaDescription,
    keyword,
    published_at: new Date().toISOString(),
  };
}

async function processClient(client) {
  console.log(`\n--- Processing: ${client.id} (${client.business_type} in ${client.location}) ---`);

  const unusedKeywords = client.keywords || [];

  if (unusedKeywords.length === 0) {
    const opportunities = client.opportunities || [];
    if (opportunities.length === 0) {
      console.log(`No keywords or opportunities for client ${client.id} — skipping`);
      return;
    }
    const toGenerate = opportunities.slice(0, 3);
    for (const keyword of toGenerate) {
      console.log(`Generating from opportunity: "${keyword}"`);
      const article = await generateArticle(client, keyword, client.website_url);
      await publishPost(article);
      console.log(`Published: ${article.title}`);
    }
    return;
  }

  const keywordObj = unusedKeywords[0];
  const keyword = keywordObj.keyword;
  const areaUrl = keywordObj.area_url || client.website_url;

  console.log(`Keyword: ${keyword}`);
  const article = await generateArticle(client, keyword, areaUrl);
  console.log(`Article generated: ${article.title}`);
  await publishPost(article);
  console.log(`Published successfully for ${client.name || client.id}`);
  await markKeywordUsed(keywordObj.id);
  console.log(`Keyword marked as used`);
}

async function runAll() {
  console.log("🚀 SEO SaaS Cron Job starting -", new Date().toISOString());

  const clients = await getAllClients();
  console.log(`Total active clients: ${clients.length}`);

  if (clients.length === 0) {
    console.log("No active clients yet.");
    return;
  }

  for (const client of clients) {
    try {
      await processClient(client);
    } catch (err) {
      console.error(`Error processing ${client.name || client.id}:`, err.message);
    }
  }

  console.log("\n✅ All clients processed!");
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/run-client") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { client_id } = JSON.parse(body);
        console.log(`\n⚡ Manual trigger for client_id: ${client_id}`);

        const clients = await getAllClients();
        const client = clients.find(c => c.id === client_id);

        if (!client) {
          console.log(`Client not found: ${client_id}`);
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Client not found" }));
          return;
        }

        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: "Generation started" }));

        await processClient(client);
        console.log(`⚡ First-run complete for client_id: ${client_id}`);

      } catch (err) {
        console.error("Error in /run-client:", err.message);
        try {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        } catch (_) {}
      }
    });
  } else if (req.method === "POST" && req.url === "/run-all") {
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, message: "Running all clients" }));
    runAll().catch(err => console.error("runAll error:", err.message));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌐 HTTP server listening on port ${PORT}`);
});
