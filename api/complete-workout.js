const { Client } = require("@notionhq/client");

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

function sendCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function getTodayInLondon() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = parts.find(part => part.type === "year").value;
  const month = parts.find(part => part.type === "month").value;
  const day = parts.find(part => part.type === "day").value;

  return `${year}-${month}-${day}`;
}

function getPlainText(richText = []) {
  return richText.map(t => t.plain_text || "").join("");
}

function getTitleFromPage(page) {
  const titleProperty = Object.values(page.properties || {}).find(
    property => property.type === "title"
  );

  if (!titleProperty) return "";

  return getPlainText(titleProperty.title);
}

async function getDatabasePropertyTypes(databaseId) {
  const database = await notion.databases.retrieve({
    database_id: databaseId,
  });

  return Object.fromEntries(
    Object.entries(database.properties || {}).map(([name, property]) => [
      name,
      property.type,
    ])
  );
}

async function completeWorkoutAction() {
  const habitLogDatabaseId = process.env.HABIT_LOG_DATABASE_ID;
  const fitnessSessionPageId = process.env.FITNESS_SESSION_TRACKER_PAGE_ID;

  if (!process.env.NOTION_TOKEN) {
    throw new Error("Missing NOTION_TOKEN in Vercel.");
  }

  if (!habitLogDatabaseId) {
    throw new Error("Missing HABIT_LOG_DATABASE_ID in Vercel.");
  }

  if (!fitnessSessionPageId) {
    throw new Error("Missing FITNESS_SESSION_TRACKER_PAGE_ID in Vercel.");
  }

  const today = getTodayInLondon();

  const fitnessSessionPage = await notion.pages.retrieve({
    page_id: fitnessSessionPageId,
  });

  const fitnessSessionTitle = getTitleFromPage(fitnessSessionPage) || "Fitness Session";

  const habitLogProperties = await getDatabasePropertyTypes(habitLogDatabaseId);

  const requiredProperties = ["Name", "Completed", "Habit Trackers", "Date"];
  const missingProperties = requiredProperties.filter(
    propertyName => !(propertyName in habitLogProperties)
  );

  if (missingProperties.length) {
    throw new Error(
      `Habit Log is missing these exact properties: ${missingProperties.join(", ")}. Current properties are: ${Object.keys(habitLogProperties).join(", ")}`
    );
  }

  const existing = await notion.databases.query({
    database_id: habitLogDatabaseId,
    filter: {
      and: [
        {
          property: "Date",
          date: {
            equals: today,
          },
        },
        {
          property: "Habit Trackers",
          relation: {
            contains: fitnessSessionPageId,
          },
        },
      ],
    },
    page_size: 1,
  });

  if (existing.results.length) {
    const existingPage = existing.results[0];

    await notion.pages.update({
      page_id: existingPage.id,
      properties: {
        "Completed": {
          checkbox: true,
        },
      },
    });

    return {
      success: true,
      action: "updated_existing_log",
      habit: fitnessSessionTitle,
      date: today,
      pageId: existingPage.id,
    };
  }

  const created = await notion.pages.create({
    parent: {
      database_id: habitLogDatabaseId,
    },
    properties: {
      "Name": {
        title: [
          {
            text: {
              content: "Fitness Session",
            },
          },
        ],
      },
      "Completed": {
        checkbox: true,
      },
      "Habit Trackers": {
        relation: [
          {
            id: fitnessSessionPageId,
          },
        ],
      },
      "Date": {
        date: {
          start: today,
        },
      },
    },
  });

  return {
    success: true,
    action: "created_new_log",
    habit: fitnessSessionTitle,
    date: today,
    pageId: created.id,
  };
}

module.exports = async function handler(req, res) {
  sendCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method === "GET") {
    try {
      const habitLogProperties = process.env.HABIT_LOG_DATABASE_ID
        ? await getDatabasePropertyTypes(process.env.HABIT_LOG_DATABASE_ID)
        : {};

      let fitnessSessionTitle = "";

      if (process.env.FITNESS_SESSION_TRACKER_PAGE_ID) {
        const fitnessSessionPage = await notion.pages.retrieve({
          page_id: process.env.FITNESS_SESSION_TRACKER_PAGE_ID,
        });

        fitnessSessionTitle = getTitleFromPage(fitnessSessionPage);
      }

      return res.status(200).json({
        status: "complete-workout endpoint is live",
        hasNotionToken: Boolean(process.env.NOTION_TOKEN),
        hasHabitLogDatabaseId: Boolean(process.env.HABIT_LOG_DATABASE_ID),
        hasFitnessSessionTrackerPageId: Boolean(process.env.FITNESS_SESSION_TRACKER_PAGE_ID),
        today: getTodayInLondon(),
        fitnessSessionTitle,
        habitLogProperties,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: "Debug check failed",
        message: error.message,
      });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed. Use POST.",
    });
  }

  try {
    const result = await completeWorkoutAction();
    return res.status(200).json(result);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      error: "Failed to complete workout",
      message: error.message,
    });
  }
};
