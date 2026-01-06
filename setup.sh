#!/bin/bash

# Ensure script stops on first error
set -e

echo "🌿 Setting up Smart Tent Environment..."

# Create virtual environment if it doesn't exist
if [ ! -d "venv" ]; then
    echo "📦 Creating virtual environment..."
    python3 -m venv venv
else
    echo "✅ Virtual environment already exists."
fi

# Activate venv just for this script execution to ensure we use the right pip
source venv/bin/activate

# Upgrade pip
echo "⬆️  Upgrading pip..."
pip install --upgrade pip

# Install dependencies
if [ -f "requirements.txt" ]; then
    echo "📥 Installing dependencies from requirements.txt..."
    pip install -r requirements.txt
    echo "✅ Dependencies installed!"
else
    echo "❌ requirements.txt not found!"
    exit 1
fi

echo "🎉 Setup complete! You can now run the app with:"
echo "   PM2:     pm2 start ecosystem.config.js"
echo "   Manual:  ./venv/bin/python backend/app.py"
