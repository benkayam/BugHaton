require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all requests
// Enable CORS for all requests
app.use(cors());

// Security: Block access to sensitive files (especially important since we serve root)
app.use((req, res, next) => {
    const sensitiveFiles = ['.env', 'server.js', 'package.json', 'web.config'];
    // Check if the request path ends with any of the sensitive files
    if (sensitiveFiles.some(file => req.path.endsWith(file) || req.path.includes(`/${file}`))) {
        return res.status(403).send('Forbidden');
    }
    next();
});

// Serve static files (HTML, CSS, JS) from the current directory
app.use(express.static(__dirname));

// Jira Configuration
const JIRA_BASE_URL = 'https://fibijira.fibi.corp/rest/api/2/search';
// Note: This JQL matches the user's specific request
const JQL_QUERY = 'type = Bug AND "Assignee Management Hierarchy" = T158429 AND status not in (Done, Cancelled) ORDER BY cf[11506] ASC';

app.get('/api/jira', async (req, res) => {
    try {
        const apiKey = process.env.JIRA_API_KEY;
        const email = process.env.JIRA_EMAIL;

        if (!apiKey || !email) {
            return res.status(500).json({ error: 'Missing JIRA_API_KEY or JIRA_EMAIL in server environment' });
        }

        // Construct Basic Auth Token (base64 encoded "email:api_token")
        const auth = Buffer.from(`${email}:${apiKey}`).toString('base64');

        // Construct the full URL with the JQL query
        // We use axios params to handle encoding correctly
        const response = await axios.get(JIRA_BASE_URL, {
            params: {
                jql: JQL_QUERY,
                // Pass through any other query params from the client if needed, e.g. maxResults
                ...req.query
            },
            headers: {
                'Authorization': `Basic ${auth}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        });

        res.json(response.data);
    } catch (error) {
        console.error('Jira Proxy Error:', error.message);
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', error.response.data);
            res.status(error.response.status).json(error.response.data);
        } else {
            res.status(500).json({ error: 'Failed to connect to Jira server' });
        }
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Proxy Server running at http://localhost:${PORT}`);
    console.log(`🔗 Endpoint: http://localhost:${PORT}/api/jira`);
});
