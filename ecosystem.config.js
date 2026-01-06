module.exports = {
    apps: [{
        name: "smart-tent",
        script: "backend/app.py",
        interpreter: "./venv/bin/python",
        env: {
            "FLASK_ENV": "production",
            "PORT": "5000"
        }
    }]
}
