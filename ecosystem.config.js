module.exports = {
    apps: [{
        name: "smart-tent",
        script: "backend/app.py",
        interpreter: "python3",
        env: {
            "FLASK_ENV": "production",
            "PORT": "5000"
        }
    }]
}
