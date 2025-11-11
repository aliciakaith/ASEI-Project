# Deploying to Render

This guide will help you deploy the ASEI project to Render.

## Prerequisites

1. A [Render account](https://render.com) (free tier available)
2. Your code pushed to a Git repository (GitHub, GitLab, or Bitbucket)
3. Environment variables ready (see `.env.example`)

## Deployment Options

### Option 1: Using Render Blueprint (Recommended)

This deploys both the database and web service together.

1. **Push your code to GitHub/GitLab**
   ```bash
   git add .
   git commit -m "Prepare for Render deployment"
   git push origin main
   ```

2. **Create a New Blueprint in Render**
   - Go to [Render Dashboard](https://dashboard.render.com)
   - Click "New" → "Blueprint"
   - Connect your repository
   - Render will detect the `render.yaml` file
   - Review and approve the resources

3. **Configure Environment Variables**
   
   In the Render dashboard, add these environment variables to your web service:
   - `JWT_SECRET` - Generate a secure random string
   - `SESSION_SECRET` - Generate a secure random string
   - `FRONTEND_URL` - Your frontend URL (e.g., `https://your-app.onrender.com`)
   - `BACKEND_URL` - Your backend URL (same as web service URL)
   - Add any API keys for integrations (MTN, Flutterwave, etc.)

4. **Deploy**
   - Render will automatically build and deploy your services
   - Database will be provisioned first, then the web service

### Option 2: Manual Setup

#### Step 1: Create PostgreSQL Database

1. In Render Dashboard, click "New" → "PostgreSQL"
2. Name: `asei-database`
3. Database: `asei_dev`
4. User: `asei_app`
5. Region: Choose closest to your users
6. Plan: Free (or paid for production)
7. Click "Create Database"
8. **Save the connection details** (Internal Database URL)

#### Step 2: Create Web Service

1. Click "New" → "Web Service"
2. Connect your repository
3. Configure:
   - **Name**: `asei-backend`
   - **Region**: Same as database
   - **Branch**: `main`
   - **Root Directory**: Leave empty
   - **Environment**: Docker
   - **Dockerfile Path**: `./backend/Dockerfile`
   - **Docker Build Context Directory**: `.` (root)
   - **Plan**: Free (or paid)

4. **Add Environment Variables**:
   ```
   NODE_ENV=production
   PORT=3001
   DATABASE_URL=[paste Internal Database URL from Step 1]
   JWT_SECRET=[generate random string]
   SESSION_SECRET=[generate random string]
   FRONTEND_URL=[your frontend URL]
   BACKEND_URL=[will be provided after creation]
   ```

5. Click "Create Web Service"

#### Step 3: Initialize Database Schema

After deployment, you need to set up your database tables:

1. In Render dashboard, go to your database
2. Click "Connect" → "External Connection"
3. Use the provided connection string with a PostgreSQL client:
   ```bash
   psql [EXTERNAL_DATABASE_URL]
   ```
4. Run your schema initialization SQL scripts

## Post-Deployment

### 1. Update CORS Origins

Make sure your backend allows requests from your frontend domain. Update CORS configuration in `backend/src/index.js` if needed.

### 2. Set up Custom Domain (Optional)

1. Go to your web service settings
2. Click "Custom Domain"
3. Add your domain and follow DNS instructions

### 3. Monitor Logs

- View logs in Render dashboard
- Check for any startup errors
- Monitor database connections

### 4. Enable Auto-Deploy (Optional)

Render can automatically deploy when you push to your repository:
- Go to service settings
- Enable "Auto-Deploy" for your branch

## Environment Variables Reference

Required variables:
- `NODE_ENV` - Set to `production`
- `PORT` - Port number (Render uses this, default 3001)
- `DATABASE_URL` - PostgreSQL connection string
- `JWT_SECRET` - Secret for JWT tokens
- `SESSION_SECRET` - Secret for sessions
- `FRONTEND_URL` - Your frontend domain
- `BACKEND_URL` - Your backend domain

Optional variables (based on features used):
- Email: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`
- OAuth: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, etc.
- Payments: `MTN_API_KEY`, `FLUTTERWAVE_SECRET_KEY`, etc.
- Security: `ALLOWED_IPS`, rate limiting configs

## Database Migration

If you have existing data, you can migrate it:

1. Export from local:
   ```bash
   pg_dump -h localhost -U asei_app asei_dev > backup.sql
   ```

2. Import to Render:
   ```bash
   psql [RENDER_EXTERNAL_DATABASE_URL] < backup.sql
   ```

## Troubleshooting

### Build Fails
- Check Dockerfile syntax
- Ensure all dependencies are in `package.json`
- Check build logs in Render dashboard

### Database Connection Issues
- Verify `DATABASE_URL` is set correctly
- Check database is in same region as web service
- Ensure database is running (check status in dashboard)

### Application Crashes
- Check logs in Render dashboard
- Verify all required environment variables are set
- Test locally with `NODE_ENV=production npm start`

### CORS Errors
- Update CORS configuration to allow your frontend domain
- Check `FRONTEND_URL` environment variable

## Costs

**Free Tier Includes:**
- PostgreSQL: 1 GB storage, shared CPU
- Web Service: 750 hours/month, 512 MB RAM
- Services spin down after 15 minutes of inactivity
- First request after spin down may be slow (cold start)

**For Production:**
- Consider upgrading to paid plans for:
  - Always-on services (no cold starts)
  - More resources (RAM, CPU)
  - Larger database storage
  - Better performance

## Useful Links

- [Render Documentation](https://render.com/docs)
- [Render PostgreSQL Docs](https://render.com/docs/databases)
- [Render Docker Deploys](https://render.com/docs/docker)
- [Environment Variables](https://render.com/docs/environment-variables)
