#!/bin/bash

# Quick Setup Script for Render Deployment

echo "🚀 ASEI Project - Render Deployment Setup"
echo "=========================================="
echo ""

# Check if Git repository exists
if [ ! -d .git ]; then
    echo "❌ No Git repository found. Initializing..."
    git init
    echo "✅ Git repository initialized"
else
    echo "✅ Git repository found"
fi

# Check if remote exists
if git remote get-url origin > /dev/null 2>&1; then
    echo "✅ Git remote 'origin' is configured"
    REMOTE_URL=$(git remote get-url origin)
    echo "   Remote: $REMOTE_URL"
else
    echo "⚠️  No Git remote configured"
    echo "   Add your repository with:"
    echo "   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git"
fi

echo ""
echo "📋 Checklist for Render Deployment:"
echo ""
echo "1. ✅ render.yaml created"
echo "2. ✅ Dockerfile configured"
echo "3. ✅ .env.example created"
echo "4. ✅ RENDER_DEPLOYMENT.md guide created"
echo ""
echo "Next steps:"
echo "----------"
echo "1. Review .env.example and prepare your environment variables"
echo "2. Push your code to GitHub/GitLab:"
echo "   git add ."
echo "   git commit -m 'Prepare for Render deployment'"
echo "   git push origin main"
echo ""
echo "3. Go to Render Dashboard: https://dashboard.render.com"
echo "4. Create New Blueprint or Web Service"
echo "5. Follow the guide in RENDER_DEPLOYMENT.md"
echo ""
echo "📖 Read RENDER_DEPLOYMENT.md for detailed instructions"
echo ""
