const { Client } = require("@notionhq/client");

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

function getPlainText(richText = []) {
  return richText.map((t) => t.plain_text).join("");
}

function getFormulaValue(property) {
  if (!property || property.type !== "formula") return "";

  const formula = property.formula;

  if (formula.type === "string") return formula.string || "";
  if (formula.type === "number") return String(formula.number ?? "");
  if (formula.type === "boolean") return formula.boolean ? "Yes" : "No";
  if (formula.type === "date") return formula.date?.start || "";

  return "";
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
      return getFormulaValue(property);

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

    case "number":
      return String(property.number ?? "");

    default:
      return "";
  }
}

function getTodayISO() {
  return new Date().toISOString().split("T")[0];
}

function cleanText(text = "") {
  return text
    .replace(/\n+/g, "\n")
    .replace(/[•✦✨]/g, "")
    .replace(/Beauty Today/g, "")
    .replace(/Workout/g, "")
    .replace(/Meals Today/g, "")
    .replace(/Nothing planned for today/gi, "")
    .replace(/Nothing right now/gi, "")
    .trim();
}

function extractLine(text, label) {
  const regex = new RegExp(`${label}:\\s*([^\\n]+)`, "i");
  const match = text.match(regex);
  return match ? match[1].trim() : "";
}

function buildDashboardData(page, today) {
  const p = page.properties;

  const dayTitle = getPropertyText(p["Day"]);
  const greeting = getPropertyText(p["Greeting"]);

  const mealPlanAssistant = getPropertyText(p["Meal Plan Assistant"]);
  const beautyTodayFormula = getPropertyText(p["Beauty Today"]);
  const workoutFormula = getPropertyText(p["Workout Formula"]);
  const cycleFormula = getPropertyText(p["Cycle Phase Formula"]);

  const breakfast =
    extractLine(mealPlanAssistant, "Breakfast") ||
    getPropertyText(p["Today Breakfast"]) ||
    "";

  const lunch =
    extractLine(mealPlanAssistant, "Lunch") ||
    getPropertyText(p["Today Lunch"]) ||
    "";

  const dinner =
    extractLine(mealPlanAssistant, "Dinner") ||
    getPropertyText(p["Today Dinner"]) ||
    "";

  const beautyToday =
    cleanText(beautyTodayFormula) ||
    cleanText(getPropertyText(p["Beauty Now"])) ||
    "Nothing right now";

  const workout =
    cleanText(workoutFormula) ||
    cleanText(getPropertyText(p["Today Workout"])) ||
    "Nothing planned for today";

  const currentPhase =
    getPropertyText(p["Current Phase"]) ||
    cleanText(cycleFormula) ||
    "";

  const stream =
    getPropertyText(p["Stream Today"]) ||
    getPropertyText(p["Stream Now"]) ||
    "";

  const score = [
    breakfast,
    lunch,
    dinner,
    beautyToday !== "Nothing right now" ? beautyToday : "",
    workout !== "Nothing planned for today" ? workout : "",
    currentPhase,
    stream,
  ].filter(Boolean).join(" ").length;

  return {
    date: today,
    pageId: page.id,
    dayTitle,
    greeting,
    currentPhase,
    beautyToday,
    breakfast,
    lunch,
    dinner,
    workout,
    stream,
    score,
    debug: {
      mealPlanAssistant,
      beautyTodayFormula,
      workoutFormula,
      cycleFormula,
      todayBreakfastRaw: getPropertyText(p["Today Breakfast"]),
      todayLunchRaw: getPropertyText(p["Today Lunch"]),
      todayDinnerRaw: getPropertyText(p["Today Dinner"]),
    },
  };
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
      page_size: 10,
    });

    if (!response.results.length) {
      return res.status(404).json({
        error: "No Daily Dashboard row found for today",
        today,
      });
    }

    const candidates = response.results.map((page) => buildDashboardData(page, today));

    candidates.sort((a, b) => b.score - a.score);

    const best = candidates[0];

    const data = {
      date: best.date,
      greeting: best.greeting,
      currentPhase: best.currentPhase,
      beautyToday: best.beautyToday,
      breakfast: best.breakfast,
      lunch: best.lunch,
      dinner: best.dinner,
      workout: best.workout,
      stream: best.stream,

      debug: {
        chosenPageId: best.pageId,
        chosenDayTitle: best.dayTitle,
        chosenScore: best.score,
        allTodayRows: candidates.map((item) => ({
          pageId: item.pageId,
          dayTitle: item.dayTitle,
          score: item.score,
          breakfast: item.breakfast,
          lunch: item.lunch,
          dinner: item.dinner,
          beautyToday: item.beautyToday,
          workout: item.workout,
        })),
        chosenRaw: best.debug,
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
