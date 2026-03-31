# RTC Backend Dashboard

A beautiful frontend dashboard for monitoring RTC (Real-Time Communication) server status and live meetings.

## Features

- 🔐 Secure authentication system with username/password
- 📊 Real-time server status monitoring
- 🏠 View active meeting rooms
- 👥 Track participants in each meeting
- 🔄 Auto-refresh every 5 seconds
- 🎨 Beautiful, responsive UI design

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables in `.env`:
```env
FRONTEND_USERNAME=admin
FRONTEND_PASSWORD=admin123
FRONTEND_SECRET=your-secret-key-change-this
```

3. Start the server:
```bash
npm start
```

4. Access the dashboard:
```
http://localhost:3001
```

## Default Credentials

- Username: `admin`
- Password: `admin123`

⚠️ **Important**: Change these credentials in the `.env` file before deploying to production!

## API Endpoints

### Authentication
- `POST /api/login` - Login with username and password
- `GET /api/logout` - Logout and invalidate token

### Dashboard Data
- `GET /api/status` - Get server status (requires authentication)
- `GET /api/health` - Get health snapshot with room and user counts (requires authentication)

## Security

- Token-based authentication
- Credentials stored in environment variables
- Tokens are invalidated on logout
- CORS protection enabled

## Development

The frontend files are located in the `public/` directory:
- `index.html` - Main dashboard
- `login.html` - Login page
- `styles.css` - Styling
- `app.js` - Dashboard JavaScript
- `login.js` - Login JavaScript