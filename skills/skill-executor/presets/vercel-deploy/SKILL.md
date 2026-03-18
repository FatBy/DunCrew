---
name: vercel-deploy
description: "Deploy web projects to Vercel with automated CLI setup, authentication, and deployment configuration."
version: "1.0.0"
author: "DunCrew"
metadata:
  openclaw:
    emoji: "🔧"
    primaryEnv: "shell"
---

# Vercel Deploy

## Description
Deploy web projects to Vercel with automated CLI setup, authentication, and deployment configuration.

## Instructions

1. **Check Prerequisites**
   - Verify Node.js is installed (`node --version`)
   - Check if Vercel CLI is installed (`vercel --version`)
   - If not installed, run: `npm i -g vercel`

2. **Verify Project Configuration**
   - Check for `package.json` with build scripts
   - Verify `vercel.json` exists (optional, for custom config)
   - Check for `.env` or `.env.local` for environment variables
   - Ensure `.gitignore` excludes sensitive files

3. **Authenticate with Vercel**
   - Run `vercel login` if not authenticated
   - Guide user through browser-based OAuth flow
   - Verify login successful with `vercel whoami`

4. **Configure Project (First Deploy)**
   If this is the first deployment:
   - Run `vercel` to initialize
   - Select or create organization
   - Set project name
   - Configure framework preset (Next.js, React, etc.)
   - Set build and output settings

5. **Set Environment Variables**
   If environment variables are needed:
   ```bash
   vercel env add VARIABLE_NAME
   ```
   Or bulk add from `.env`:
   - Read `.env` file
   - Add each variable with appropriate scope (Production, Preview, Development)

6. **Deploy**
   For preview deployment:
   ```bash
   vercel
   ```
   
   For production deployment:
   ```bash
   vercel --prod
   ```

7. **Verify Deployment**
   - Check deployment URL in output
   - Open preview URL to verify
   - Check build logs for errors: `vercel logs`
   - Verify environment variables are set correctly

8. **Post-Deployment**
   - Note the deployment URL
   - If production, verify the production domain
   - Set up custom domain if needed: `vercel domains add`

## Examples

**Deploy Next.js App:**
```bash
# Install Vercel CLI
npm i -g vercel

# Login
vercel login

# Deploy preview
vercel

# Deploy production
vercel --prod
```

**Add Environment Variables:**
```bash
# Add single variable
vercel env add DATABASE_URL

# Add to production only
vercel env add API_KEY production
```

## Notes

- Never commit `.env` files with secrets
- Use preview deployments for testing
- Production deploys go to main domain
- Set up GitHub integration for automatic deploys
- Check Vercel dashboard for detailed logs
