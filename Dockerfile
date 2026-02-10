FROM ghcr.io/puppeteer/puppeteer:21.5.2

# Set working directory
WORKDIR /app

# Switch to root to install dependencies if needed, though usually puppeteer user is default
# The official image creates a non-root 'pptruser'. We need to be careful with permissions.
# Let's run as root for setup, then switch back if needed, or stick with root for simplicity in this context
# (Docker inside VPS often easier with root unless strict security required).
# Actually, the ghcr.io/puppeteer/puppeteer image runs as pptruser by default.
USER root

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
# We use --unsafe-perm because we are root, to ensure scripts run
RUN npm ci --unsafe-perm=true

# Copy the rest of the application
COPY . .

# Create necessary directories and set permissions for pptruser
RUN mkdir -p data public/media \
    && chown -R pptruser:pptruser /app

# Switch to non-root user for security and Puppeteer compatibility
USER pptruser

# Expose the dashboard port
EXPOSE 3456

# Start the application
CMD ["npm", "start"]
