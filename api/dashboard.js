const { Client } = require("@notionhq/client");

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

function getPlainText(richText = []) {
  return richText.map((t) => t.plain_text || "").join("");
}

function getPageTitle(page) {
  if (!page || !page.properties) return "";

  const titleProperty = Object.values(page.properties).find(
    (property) => property.type === "title"
  );

  if (!titleProperty) return "";

  return getPlainText(titleProperty.title);
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

function getBasicPropertyText(property) {
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

    case "multi_select":
      return property.multi_select?.map((item) => item.name).join(", ") || "";

    case "checkbox":
      return property.checkbox ? "Yes" : "No";

    case "number":
      return String(property.number ?? "");

    case "url":
      return property.url || "";

    case "email":
      return property.email || "";

    case "phone_number":
      return property.phone_number || "";

    case "relation":
      if (Array.isArray(property.relation)) {
        return property.relation.length ? `${property.relation.length} linked` : "";
      }
      if (property.relation?.id) {
        return "1 linked";
      }
      return "";

    case "rollup":
      if (property.rollup.type === "array") {
        return property.rollup.array.map(getBasicPropertyText).filter(Boolean).join(", ");
      }
      if (property.rollup.type === "number") return String(property.rollup.number ?? "");
      if (property.rollup.type === "date") return property.rollup.date?.start || "";
      return "";

    default:
      return "";
  }
}

async function resolveRelationTitles(property) {
  if (!property) return "";

  const relationItems = Array.isArray(property.relation)
    ? property.relation
    : property.relation?.id
      ? [property.relation]
      : [];

  if (!relationItems.length) return "";

  const titles = [];

  for (const item of relationItems) {
    try {
      const page = await notion.pages.retrieve({ page_id: item.id });
      const title = getPageTitle(page);
      if (title) titles.push(title);
    } catch (error) {
      // Ignore inaccessible relation pages
    }
  }

  return titles.join(", ");
}

async function getDeepPropertyText(pageId, property) {
  if (!property) return "";

  if (property.type === "relation") {
    const relationTitles = await resolveRelationTitles(property);
    return relationTitles || getBasicPropertyText(property);
  }

  if (property.type === "rollup" && property.rollup.type === "array") {
    const parts = [];

    for (const item of property.rollup.array) {
      if (item.type === "relation") {
        const relationTitles = await resolveRelationTitles(item);
        if (relationTitles) parts.push(relationTitles);
      } else {
        const text = getBasicPropertyText(item);
        if (text) parts.push(text);
      }
    }

    if (parts.length) return parts.join(", ");
  }

  if (!property.id || !pageId) return getBasicPropertyText(property);

  try {
    const response = await notion.pages.properties.retrieve({
      page_id: pageId,
      property_id: property.id,
    });

    if (response.object === "list" && Array.isArray(response.results)) {
      const parts = [];

      for (const item of response.results) {
        if (item.type === "relation") {
          const relationTitles = await resolveRelationTitles(item);
          if (relationTitles) parts.push(relationTitles);
        } else {
          const text = getBasicPropertyText(item);
          if (text) parts.push(text);
        }
      }

      return parts.join(", ");
    }

    if (response.type === "relation") {
      const relationTitles = await resolveRelationTitles(response);
      return relationTitles || getBasicPropertyText(response);
    }

    return getBasicPropertyText(response);
  } catch (error) {
    return getBasicPropertyText(property);
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
    .replace(/\d+ linked/gi, "")
    .trim();
}

function extractLine(text, label) {
  const regex = new RegExp(`${label}:\\s*([^\\n]+)`, "i");
  const match = text.match(regex);
  return match ? match[1].trim() : "";
}

/**
 * This loads the same permanent Daily Dashboard card every day.
 * It no longer searches for a row where Date = today.
 */
async function getDashboardCard() {
  const databaseId = process.env.DAILY_DASHBOARD_DATABASE_ID;

  const response = await notion.databases.query({
    database_id: databaseId,
    page_size: 1,
  });

  if (!response.results.length) return null;

  const page = response.results[0];
  const p = page.properties;

  const beautyNow = await getDeepPropertyText(page.id, p["Beauty Now"]);
  const todayWorkout = await getDeepPropertyText(page.id, p["Today Workout"]);
  const currentPhase = await getDeepPropertyText(page.id, p["Current Phase"]);

  return {
    pageId: page.id,
    greeting: getBasicPropertyText(p["Greeting"]),

    beautyToday:
      cleanText(getBasicPropertyText(p["Beauty Today"])) ||
      cleanText(beautyNow) ||
      "Nothing right now",

    workout:
      cleanText(getBasicPropertyText(p["Workout Formula"])) ||
      cleanText(todayWorkout) ||
      "Nothing planned for today",

    currentPhase:
      cleanText(currentPhase) ||
      cleanText(getBasicPropertyText(p["Cycle Phase Formula"])) ||
      "",

    stream:
      getBasicPropertyText(p["Stream Today"]) ||
      getBasicPropertyText(p["Stream Now"]) ||
      "",
  };
}

async function buildMealData(page) {
  const p = page.properties;
  const pageId = page.id;

  const formula = getBasicPropertyText(p["Formula"]);

  const breakfastDirect = await getDeepPropertyText(pageId, p["Breakfast"]);
  const lunchDirect = await getDeepPropertyText(pageId, p["Lunch"]);
  const dinnerDirect = await getDeepPropertyText(pageId, p["Dinner"]);
  const snacksDirect = await getDeepPropertyText(pageId, p["Snacks"]);

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
    name: getBasicPropertyText(p["Name"]),
    date: getBasicPropertyText(p["Date"]),
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
      propertyTypes: Object.fromEntries(
        Object.entries(p).map(([name, property]) => [name, property.type])
      ),
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
    response.results.map((page) => buildMealData(page))
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

    const dashboard = await getDashboardCard();

    if (!dashboard) {
      return res.status(404).json({
        error: "No Daily Dashboard card found",
      });
    }

    const meals = await getTodayMeals(today);

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

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
