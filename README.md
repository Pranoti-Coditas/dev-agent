# jira-dev-agent

The agent code. See ../README.md for the full step-by-step guide.

    npm install
    cp .env.example .env      # set LLM_PROVIDER + API key (anthropic or openai)
    npm run check             # offline self-test, no API key needed
    npm run agent -- run DEMO-1 --repo ../demo-app
