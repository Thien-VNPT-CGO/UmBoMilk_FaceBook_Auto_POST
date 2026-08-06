import { Router } from 'express';
import { changePassword, login, logout, refreshToken } from './auth.controller';
import { authenticate } from '../../common/guards/auth.guard';

const router = Router();

router.post('/login', login);
router.post('/refresh', refreshToken);
router.post('/logout', authenticate, logout);
router.post('/change-password', authenticate, changePassword);

export default router;