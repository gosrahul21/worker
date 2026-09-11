const { Client } = require('@notionhq/client');
const config = require('../config');

let notionClient = null;

function getClient() {
  if (!notionClient) {
    notionClient = new Client({ auth: config.notion.apiKey });
  }
  return notionClient;
}

/**
 * Normalizes Notion API page properties into a clean Task object
 */
function normalizeTaskPage(page) {
  const props = page.properties || {};

  // Extract Title (Name)
  let name = '(Untitled Task)';
  if (props.Name && props.Name.title && props.Name.title.length > 0) {
    name = props.Name.title.map((t) => t.plain_text).join('');
  }

  // Extract Status
  let status = 'Not started';
  if (props.status && props.status.status) {
    status = props.status.status.name;
  }

  // Extract Due Date
  let dueDate = null;
  if (props['Due Date'] && props['Due Date'].date && props['Due Date'].date.start) {
    dueDate = new Date(props['Due Date'].date.start);
  }

  // Extract Completed At Date
  let completedAt = null;
  if (props['Completed At'] && props['Completed At'].date && props['Completed At'].date.start) {
    completedAt = new Date(props['Completed At'].date.start);
  }

  // Extract Priority
  let priority = 'Medium';
  if (props.priority && props.priority.select) {
    priority = props.priority.select.name;
  }

  // Last edited time
  const lastEditedTime = props['Last edited time'] && props['Last edited time'].last_edited_time
    ? new Date(props['Last edited time'].last_edited_time)
    : new Date(page.last_edited_time);

  return {
    id: page.id,
    url: page.url,
    name,
    status,
    dueDate,
    completedAt,
    priority,
    lastEditedTime,
  };
}

/**
 * Fetch all tasks from Notion database
 */
async function fetchAllTasks() {
  const client = getClient();
  try {
    let results = [];
    if (client.dataSources && config.notion.dataSourceId) {
      const res = await client.dataSources.query({ data_source_id: config.notion.dataSourceId });
      results = res.results || [];
    } else {
      const res = await client.databases.query({ database_id: config.notion.databaseId });
      results = res.results || [];
    }

    const tasks = results.map(normalizeTaskPage);
    console.log(`[NotionService] Fetched ${tasks.length} tasks from Notion database.`);
    return tasks;
  } catch (err) {
    console.error('[NotionService] Error fetching tasks from Notion:', err.message);
    return [];
  }
}

/**
 * Filter tasks by status categories
 */
function categorizeTasks(tasks) {
  const pending = [];
  const active = [];
  const completedToday = [];

  const todayStr = new Date().toISOString().split('T')[0];

  for (const t of tasks) {
    const statusLower = t.status.toLowerCase();
    if (statusLower === 'in progress' || statusLower === 'active') {
      active.push(t);
    } else if (statusLower === 'not started' || statusLower === 'pending' || statusLower === 'to-do') {
      pending.push(t);
    } else if (statusLower === 'done' || statusLower === 'completed') {
      const completedStr = t.completedAt ? t.completedAt.toISOString().split('T')[0] : null;
      const editedStr = t.lastEditedTime ? t.lastEditedTime.toISOString().split('T')[0] : null;
      if (completedStr === todayStr || editedStr === todayStr) {
        completedToday.push(t);
      }
    }
  }

  return { pending, active, completedToday };
}

module.exports = {
  fetchAllTasks,
  categorizeTasks,
};
