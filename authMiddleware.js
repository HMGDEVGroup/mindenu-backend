export function requireUID(req, res, next) {
  const uid =
    req.headers["x-mindenu-uid"] ||
    req.query.uid ||
    req.body?.uid ||
    req.body?.user?.uid;

  if (!uid) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized",
      details: "Missing uid (send x-mindenu-uid header or uid field)",
    });
  }

  req.uid = String(uid);
  next();
}