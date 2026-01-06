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

# Setup Environment Variables
if [ ! -f ".env" ]; then
    echo "⚠️  No .env file found."
    if [ -f "config.example.env" ]; then
        echo "📝 Creating .env from config.example.env..."
        cp config.example.env .env
        echo "❗ ACTION REQUIRED: Please edit .env with your actual credentials!"
    else
        echo "❌ config.example.env not found! Cannot create .env automatically."
    fi
else
    echo "✅ .env file already exists."
fi

# Setup Environment Variables
if [ ! -f ".env" ]; then
    echo "⚠️  No .env file found."
    if [ -f "config.example.env" ]; then
        echo "📝 Creating .env from config.example.env..."
        cp config.example.env .env
        echo "❗ ACTION REQUIRED: Please edit .env with your actual credentials!"
    else
        echo "❌ config.example.env not found! Cannot create .env automatically."
    fi
else
    echo "✅ .env file already exists."
fi

echo "🎉 Setup complete! You can now run the app with:"
echo "   PM2:     pm2 start ecosystem.config.js"
echo "   Manual:  ./venv/bin/python backend/app.py"
