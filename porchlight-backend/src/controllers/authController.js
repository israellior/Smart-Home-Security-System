import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function signToken(user) {
  // "sub" (subject) is the standard JWT claim for "who is this token about".
  return jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET, {
    expiresIn: '7d'
  });
}

function publicUser(user) {
  return { id: user._id, name: user.name, email: user.email };
}

export async function register(req, res) {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are all required' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'That email address doesn\'t look valid' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ name, email, passwordHash });

  const token = signToken(user);
  return res.status(201).json({ token, user: publicUser(user) });
}

export async function login(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const user = await User.findOne({ email: email.toLowerCase() });
  // Deliberately the same error for "no such user" and "wrong password" -
  // being specific here would let an attacker enumerate valid emails.
  if (!user) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }

  const matches = await bcrypt.compare(password, user.passwordHash);
  if (!matches) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }

  const token = signToken(user);
  return res.json({ token, user: publicUser(user) });
}

export async function me(req, res) {
  const user = await User.findById(req.userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  return res.json({ user: publicUser(user) });
}
