// IssueSync/sync-issues.js
// ───────────────────────────
// ES Module format. “Assignee” support added.
// Syncs Google Sheets with GitHub Issues.

import { google } from 'googleapis';
import { Octokit } from '@octokit/rest';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

(async () => {
  try {
    // 1) Read environment variables
    const sheetsCredentials = JSON.parse(process.env.GCP_SHEETS_CREDENTIALS);
    const spreadsheetId = process.env.GSHEET_ID;
    const sheetName = process.env.SHEET_NAME || 'Sheet1';
    const githubToken = process.env.GITHUB_TOKEN;
    const repoOwner = process.env.REPO_OWNER;
    const repoName = process.env.REPO_NAME;
    const defaultAssignee = process.env.DEFAULT_ASSIGNEE || '';

    // 2) Prepare Google Sheets API client
    const auth = new google.auth.JWT(
      sheetsCredentials.client_email,
      null,
      sheetsCredentials.private_key,
      ['https://www.googleapis.com/auth/spreadsheets']
    );
    const sheetsApi = google.sheets({ version: 'v4', auth });

    // 3) Prepare GitHub API client (Octokit)
    const octokit = new Octokit({ auth: githubToken });

    // 4) Fetch A:G range from Google Sheet (including Assignee column)
    const getResponse = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:G`,
    });

    const rows = getResponse.data.values;
    if (!rows || rows.length === 0) {
      console.log('No data found in the Sheet.');
      return;
    }

    const dataRows = rows.slice(1); // Skip header row

    // 5) Prepare to record newly created issue numbers
    const updatedIssueNumbers = [];

    // 6) Loop through each data row
    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const id = row[0];
      const title = row[1];
      const description = row[2];
      const priority = row[3] || '';
      const status = row[4] || 'Open';
      let issueNumber = row[5] ? parseInt(row[5], 10) : null;
      const sheetAssignee = row[6] ? row[6].trim() : '';

      if (!issueNumber) {
        // a) If “Issue Number” is empty → create a new GitHub Issue
        const bodyText = `**ID:** ${id}\n**Priority:** ${priority}\n\n${description}`;

        // Determine assignee: sheet value or default
        let assigneesArray = [];
        if (sheetAssignee) {
          assigneesArray = [sheetAssignee];
        } else if (defaultAssignee) {
          assigneesArray = [defaultAssignee];
        }

        const createResponse = await octokit.issues.create({
          owner: repoOwner,
          repo: repoName,
          title: title,
          body: bodyText,
          labels: priority
            ? [`priority:${priority.toLowerCase()}`]
            : [],
          assignees: assigneesArray,
        });

        issueNumber = createResponse.data.number;
        console.log(
          `Created new issue: #${issueNumber} — ${title} (assigned to: ${assigneesArray.join(', ') || 'none'})`
        );

        updatedIssueNumbers.push({ rowIndex: i + 1, issueNumber });
      } else {
        // b) If “Issue Number” already exists → fetch and update the existing Issue
        const { data: existingIssue } = await octokit.issues.get({
          owner: repoOwner,
          repo: repoName,
          issue_number: issueNumber,
        });

        // 1) Update state if needed
        const ghState = existingIssue.state; // 'open' or 'closed'
        const sheetStatus = status.toLowerCase() === 'closed' ? 'closed' : 'open';
        if (ghState !== sheetStatus) {
          await octokit.issues.update({
            owner: repoOwner,
            repo: repoName,
            issue_number: issueNumber,
            state: sheetStatus,
          });
          console.log(`Updated issue #${issueNumber} state to ${sheetStatus}`);
        }

        // 2) Update title or description if changed
        if (
          existingIssue.title !== title ||
          !existingIssue.body.includes(description)
        ) {
          const newBody = `**ID:** ${id}\n**Priority:** ${priority}\n\n${description}`;
          await octokit.issues.update({
            owner: repoOwner,
            repo: repoName,
            issue_number: issueNumber,
            title: title,
            body: newBody,
          });
          console.log(`Updated issue #${issueNumber} content.`);
        }

        // 3) Update assignee if needed
        const existingAssignees = existingIssue.assignees.map((u) => u.login);
        let targetAssignee = '';
        if (sheetAssignee) {
          targetAssignee = sheetAssignee;
        } else if (defaultAssignee) {
          targetAssignee = defaultAssignee;
        }
        // If current assignee differs from target, update
        if (
          (targetAssignee && !existingAssignees.includes(targetAssignee)) ||
          (!targetAssignee && existingAssignees.length > 0)
        ) {
          await octokit.issues.update({
            owner: repoOwner,
            repo: repoName,
            issue_number: issueNumber,
            assignees: targetAssignee ? [targetAssignee] : [],
          });
          console.log(
            `Updated issue #${issueNumber} assignee to: ${targetAssignee || 'none'}`
          );
        }
      }
    }

    // 7) Write any newly created issue numbers back to the Sheet (column F)
    if (updatedIssueNumbers.length > 0) {
      const updates = updatedIssueNumbers.map((item) => {
        const sheetRow = item.rowIndex + 1; // Sheet rows are 1-based
        return {
          range: `${sheetName}!F${sheetRow}`,
          values: [[item.issueNumber.toString()]],
        };
      });

      await sheetsApi.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'RAW',
          data: updates,
        },
      });
      console.log('Wrote new issue numbers back to the Sheet.');
    }

    console.log('Sync process completed successfully.');
  } catch (error) {
    console.error('Error occurred:', error);
    process.exit(1);
  }
})();
