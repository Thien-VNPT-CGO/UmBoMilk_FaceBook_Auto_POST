import { Router } from 'express';
import { authenticate } from '../../common/guards/auth.guard';
import { requirePermission } from '../../common/guards/rbac.guard';
import * as usersController from './users.controller';

const router = Router();
router.use(authenticate);

router.get('/', requirePermission('users.view'), usersController.list);
router.get('/:id', requirePermission('users.view'), usersController.get);
router.post('/', requirePermission('users.create'), usersController.create);
router.put('/:id', requirePermission('users.update'), usersController.update);
router.delete('/:id', requirePermission('users.delete'), usersController.remove);

export default router;