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

async function getDeepPropertyText(pageId, property) {
  if (!property?.id) return getPropertyText(property);

  try {
    const response = await notion.pages.properties.retrieve({
      page_id: pageId,
      property_id: property.id,
    });

    if (response.object === "list" && Array.isArray(response.results)) {
      return response.results.map(getPropertyText).filter(Boolean).join(", ");
    }

    return getPropertyText(response);
  } catch (error) {
    return getPropertyText(property);
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

async function getTodayDashboard(today) {
  const databaseId = process.env.DAILY_DASHBOARD_DATABASE_ID;

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

  if (!response.results.length) return null;

  const page = response.results[0];
  const p = page.properties;

  return {
    pageId: page.id,
    greeting: getPropertyText(p["Greeting"]),
    beautyToday:
      cleanText(getPropertyText(p["Beauty Today"])) ||
      cleanText(getPropertyText(p["Beauty Now"])) ||
      "Nothing right now",
    workout:
      cleanText(getPropertyText(p["Workout Formula"])) ||
      cleanText(getPropertyText(p["Today Workout"])) ||
      "Nothing planned for today",
    currentPhase:
      getPropertyText(p["Current Phase"]) ||
      cleanText(getPropertyText(p["Cycle Phase Formula"])) ||
      "",
    stream:
      getPropertyText(p["Stream Today"]) ||
      getPropertyText(p["Stream Now"]) ||
      "",
  };
}

async function buildMealData(page, today) {
  const p = page.properties;
  const pageId = page.id;

  const formula = getPropertyText(p["Formula"]);

  const breakfastDirect = getPropertyText(p["Breakfast"]);
  const lunchDirect = getPropertyText(p["Lunch"]);
  const dinnerDirect = getPropertyText(p["Dinner"]);
  const snacksDirect = getPropertyText(p["Snacks"]);

  const todayBreakfastDeep = await getDeepPropertyText(pageId, p["Today Breakfast"]);
  const todayLunchDeep = await getDeepPropertyText(pageId, p["Today Lunch"]);
  const todayDinnerDeep = await getDeepPropertyText(pageId, p["Today Dinner"]);

  const breakfast =
    cleanText(breakfastDirect) ||
    cleanText(todayBreakfastDeep) ||
    extractLine(formula, "Breakfast") ||
    "";

  const lunch =
    cleanText(lunchDirect) ||
    cleanText(todayLunchDeep) ||
    extractLine(formula, "Lunch") ||
    "";

  const dinner =
    cleanText(dinnerDirect) ||
    cleanText(todayDinnerDeep) ||
    extractLine(formula, "Dinner") ||
    "";

  const snacks =
    cleanText(snacksDirect) ||
    extractLine(formula, "Snacks") ||
    "";

  const score = [breakfast, lunch, dinner, snacks].filter(Boolean).join(" ").length;

  return {
    mealPageId: page.id,
    name: getPropertyText(p["Name"]),
    date: getPropertyText(p["Date"]),
    breakfast,
    lunch,
    dinner,
    snacks,
    score,
    debug: {
      formula,
      breakfastDirect,
      lunchDirect,
      dinnerDirect,
      snacksDirect,
      todayBreakfastDeep,
      todayLunchDeep,
      todayDinnerDeep,
      availableMealProperties: Object.keys(p),
    },
  };
}

async function getTodayMeals(today) {
  const databaseId = process.env.MEAL_PLAN_DATABASE_ID;

  if (!databaseId) {
    return {
      breakfast: "",
      lunch: "",
      dinner: "",
      snacks: "",
      debug: "Missing MEAL_PLAN_DATABASE_ID",
    };
  }

  const response = await notion.databases.query({
    database_id: databaseId,
    filter: {
      or: [
        {
          property: "Date",
          date: {
            equals: today,
          },
        },
        {
          property: "Is Today",
          checkbox: {
            equals: true,
          },
        },
      ],
    },
    page_size: 10,
  });

  if (!response.results.length) {
    return {
      breakfast: "",
      lunch: "",
      dinner: "",
      snacks: "",
      debug: "No meal plan row found for today",
    };
  }

  const candidates = await Promise.all(
    response.results.map((page) => buildMealData(page, today))
  );

  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];

  return {
    breakfast: best.breakfast,
    lunch: best.lunch,
    dinner: best.dinner,
    snacks: best.snacks,
    debug: {
      chosenMealPageId: best.mealPageId,
      chosenMealName: best.name,
      chosenMealDate: best.date,
      chosenMealScore: best.score,
      allMealRows: candidates.map((item) => ({
        mealPageId: item.mealPageId,
        name: item.name,
        date: item.date,
        score: item.score,
        breakfast: item.breakfast,
        lunch: item.lunch,
        dinner: item.dinner,
        snacks: item.snacks,
      })),
      chosenRaw: best.debug,
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
    if (!process.env.NOTION_TOKEN || !process.env.DAILY_DASHBOARD_DATABASE_ID) {
      return res.status(500).json({
        error: "Missing NOTION_TOKEN or DAILY_DASHBOARD_DATABASE_ID",
      });
    }

    const today = getTodayISO();

    const dashboard = await getTodayDashboard(today);

    if (!dashboard) {
      return res.status(404).json({
        error: "No Daily Dashboard row found for today",
        today,
      });
    }

    const meals = await getTodayMeals(today);

    return res.status(200).json({
      date: today,
      greeting: dashboard.greeting,
      currentPhase: dashboard.currentPhase,
      beautyToday: dashboard.beautyToday,
      breakfast: meals.breakfast,
      lunch: meals.lunch,
      dinner: meals.dinner,
      snacks: meals.snacks,
      workout: dashboard.workout,
      stream: dashboard.stream,
      debug: {
        dashboardPageId: dashboard.pageId,
        mealsDebug: meals.debug,
      },
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Failed to fetch Daily Dashboard",
      message: error.message,
    });
  }
};
