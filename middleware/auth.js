const jwt = require('jsonwebtoken');

function checkAuthenticated(req, res, next) {
    const token = req.cookies.token;

    const isApi = req.headers.accept && req.headers.accept.includes('application/json');

    if (!token) {
        if (isApi) return res.status(401).json({ error: 'Unauthorized' });
        return res.redirect('/login');
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        if (isApi) return res.status(401).json({ error: 'Invalid Token' });
        return res.redirect('/login');
    }
}

function checkNotAuthenticated(req, res, next) {
    const token = req.cookies.token;
    if (token) {
        try {
            jwt.verify(token, process.env.JWT_SECRET);
            return res.redirect('/mixers');
        } catch (err) {

            next();
        }
    } else {
        next();
    }
}

module.exports = { checkAuthenticated, checkNotAuthenticated };
