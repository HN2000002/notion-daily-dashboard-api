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

async function findFitnessSessionTrackerPage() {
  const habitTrackersDatabaseId = process.env.HABIT_TRACKERS_DATABASE_ID;

  if (!habitTrackersDatabaseId) {
    throw new Error("Missing HABIT_TRACKERS_DATABASE_ID in Vercel.");
  }

  const response = await notion.databases.query({
    database_id: habitTrackersDatabaseId,
    page_size: 100,
  });

  const pages = response.results || [];

  const titles = pages.map(page => ({
    id: page.id,
    title: getTitleFromPage(page),
  }));

  const exactMatch = pages.find(page =>
    getTitleFromPage(page).trim().toLowerCase() === "fitness session"
  );

  const softMatch = pages.find(page =>
    getTitleFromPage(page).trim().toLowerCase().includes("fitness")
  );

  const fitnessPage = exactMatch || softMatch;

  if (!fitnessPage) {
    throw new Error(
      `Could not find a Habit Trackers page called "Fitness Session". Found: ${titles.map(t => t.title || "(blank)").join(", ")}`
    );
  }

  return {
    page: fitnessPage,
    foundTitles: titles,
  };
}

async function completeWorkoutAction() {
  const habitLogDatabaseId = process.env.HABIT_LOG_DATABASE_ID;

  if (!process.env.NOTION_TOKEN) {
    throw new Error("Missing NOTION_TOKEN in Vercel.");
  }

  if (!habitLogDatabaseId) {
    throw new Error("Missing HABIT_LOG_DATABASE_ID in Vercel.");
  }

  const today = getTodayInLondon();

  const { page: fitnessSessionPage, foundTitles } =
    await findFitnessSessionTrackerPage();

  const fitnessSessionPageId = fitnessSessionPage.id;
  const fitnessSessionTitle = getTitleFromPage(fitnessSessionPage) || "Fitness Session";

  const habitLogProperties = await getDatabasePropertyTypes(habitLogDatabaseId);

  const requiredProperties = ["Name", "Completed", "Habit Trackers", "Date", "Hide"];
  const missingProperties = requiredProperties.filter(
    propertyName => !(propertyName in habitLogProperties)
  );

  if (missingProperties.length) {
    throw new Error(
      `Habit Log is missing these exact properties: ${missingProperties.join(", ")}. Current properties are: ${Object.keys(habitLogProperties).join(", ")}`
    );
  }

  if (habitLogProperties["Name"] !== "title") {
    throw new Error(`Habit Log property "Name" must be title, but it is ${habitLogProperties["Name"]}.`);
  }

  if (habitLogProperties["Completed"] !== "checkbox") {
    throw new Error(`Habit Log property "Completed" must be checkbox, but it is ${habitLogProperties["Completed"]}.`);
  }

  if (habitLogProperties["Habit Trackers"] !== "relation") {
    throw new Error(`Habit Log property "Habit Trackers" must be relation, but it is ${habitLogProperties["Habit Trackers"]}.`);
  }

  if (habitLogProperties["Date"] !== "date") {
    throw new Error(`Habit Log property "Date" must be date, but it is ${habitLogProperties["Date"]}.`);
  }

  if (habitLogProperties["Hide"] !== "checkbox") {
    throw new Error(`Habit Log property "Hide" must be checkbox, but it is ${habitLogProperties["Hide"]}.`);
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
        "Hide": {
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
      foundHabitTrackerTitles: foundTitles,
      habitLogProperties,
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
      "Hide": {
        checkbox: true,
      },
    },
  });

  return {
    success: true,
    action: "created_new_log",
    habit: fitnessSessionTitle,
    date: today,
    pageId: created.id,
    foundHabitTrackerTitles: foundTitles,
    habitLogProperties,
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

      let habitTrackerTitles = [];

      if (process.env.HABIT_TRACKERS_DATABASE_ID) {
        const response = await notion.databases.query({
          database_id: process.env.HABIT_TRACKERS_DATABASE_ID,
          page_size: 100,
        });

        habitTrackerTitles = response.results.map(page => getTitleFromPage(page));
      }

      return res.status(200).json({
        status: "complete-workout endpoint is live",
        hasNotionToken: Boolean(process.env.NOTION_TOKEN),
        hasHabitLogDatabaseId: Boolean(process.env.HABIT_LOG_DATABASE_ID),
        hasHabitTrackersDatabaseId: Boolean(process.env.HABIT_TRACKERS_DATABASE_ID),
        today: getTodayInLondon(),
        habitLogProperties,
        habitTrackerTitles,
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
