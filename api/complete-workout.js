const { Client } = require("@notionhq/client");

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

function sendCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
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

async function findFitnessSessionTrackerPage() {
  const habitTrackersDatabaseId = process.env.HABIT_TRACKERS_DATABASE_ID;

  if (!habitTrackersDatabaseId) {
    throw new Error("Missing HABIT_TRACKERS_DATABASE_ID");
  }

  const response = await notion.databases.query({
    database_id: habitTrackersDatabaseId,
    filter: {
      property: "Name",
      title: {
        equals: "Fitness Session",
      },
    },
    page_size: 1,
  });

  if (!response.results.length) {
    throw new Error('Could not find "Fitness Session" in Habit Trackers database.');
  }

  return response.results[0];
}

module.exports = async function handler(req, res) {
  sendCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed. Use POST.",
    });
  }

  try {
    const habitLogDatabaseId = process.env.HABIT_LOG_DATABASE_ID;

    if (!process.env.NOTION_TOKEN || !habitLogDatabaseId) {
      return res.status(500).json({
        error: "Missing NOTION_TOKEN or HABIT_LOG_DATABASE_ID",
      });
    }

    const today = getTodayInLondon();
    const fitnessSessionPage = await findFitnessSessionTrackerPage();
    const fitnessSessionPageId = fitnessSessionPage.id;

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

      return res.status(200).json({
        success: true,
        action: "updated_existing_log",
        habit: getTitleFromPage(fitnessSessionPage),
        date: today,
        pageId: existingPage.id,
      });
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

    return res.status(200).json({
      success: true,
      action: "created_new_log",
      habit: getTitleFromPage(fitnessSessionPage),
      date: today,
      pageId: created.id,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Failed to complete workout",
      message: error.message,
    });
  }
};
