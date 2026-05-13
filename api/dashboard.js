const { Client } = require("@notionhq/client");

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

function getPlainText(richText = []) {
  return richText.map((t) => t.plain_text).join("");
}

function getPropertyText(property) {
  if (!property) return "";

  switch (property.type) {
    case "title":
      return getPlainText(property.title);

    case "rich_text":
      return getPlainText(property.rich_text);

    case "select":
      return property.select?.name || "";

    case "status":
      return property.status?.name || "";

    case "date":
      return property.date?.start || "";

    case "formula":
      if (property.formula.type === "string") return property.formula.string || "";
      if (property.formula.type === "number") return String(property.formula.number ?? "");
      if (property.formula.type === "boolean") return property.formula.boolean ? "Yes" : "No";
      if (property.formula.type === "date") return property.formula.date?.start || "";
      return "";

    case "rollup":
      if (property.rollup.type === "array") {
        return property.rollup.array.map(getPropertyText).filter(Boolean).join(", ");
      }
      if (property.rollup.type === "number") return String(property.rollup.number ?? "");
      if (property.rollup.type === "date") return property.rollup.date?.start || "";
      return "";

    case "relation":
      return property.relation?.length ? `${property.relation.length} linked` : "";

    case "multi_select":
      return property.multi_select?.map((item) => item.name).join(", ") || "";

    case "checkbox":
      return property.checkbox ? "Yes" : "No";

    default:
      return "";
  }
}

function getTodayISO() {
  return new Date().toISOString().split("T")[0];
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const databaseId = process.env.DAILY_DASHBOARD_DATABASE_ID;

    if (!process.env.NOTION_TOKEN || !databaseId) {
      return res.status(500).json({
        error: "Missing NOTION_TOKEN or DAILY_DASHBOARD_DATABASE_ID",
      });
    }

    const today = getTodayISO();

    const response = await notion.databases.query({
      database_id: databaseId,
      filter: {
        property: "Date",
        date: {
          equals: today,
        },
      },
      page_size: 1,
    });

    if (!response.results.length) {
      return res.status(404).json({
        error: "No Daily Dashboard row found for today",
        today,
      });
    }

    const page = response.results[0];
    const p = page.properties;

    const data = {
      date: today,
      greeting: getPropertyText(p["Greeting"]),
      currentPhase: getPropertyText(p["Current Phase"]) || getPropertyText(p["Cycle Phase Formula"]),
      beautyToday: getPropertyText(p["Beauty Now"]) || getPropertyText(p["Today’s Beauty"]) || getPropertyText(p["Today's Beauty"]),
      breakfast: getPropertyText(p["Today Breakfast"]),
      lunch: getPropertyText(p["Today Lunch"]),
      dinner: getPropertyText(p["Today Dinner"]),
      workout: getPropertyText(p["Workout Formula"]) || getPropertyText(p["Today Workout"]),
      stream: getPropertyText(p["Stream Now"]) || getPropertyText(p["Stream Today"]),
      raw: {
        pageId: page.id,
      },
    };

    return res.status(200).json(data);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Failed to fetch Daily Dashboard",
      message: error.message,
    });
  }
};
