// Layer 9B — shopping workflow routes under
// /v1/profiles/:profile_id/grocery-lists/:grocery_list_id. User state is set
// or revoked (never edited or deleted); the generated list is never changed.
// No retailer, cart or checkout endpoints.

import { Router, type RequestHandler } from 'express';
import { AppError } from '../../lib/errors';
import { validate } from '../../middleware/validate';
import type { AuthContext } from '../../types/express';
import { groceryListParamSchema } from './grocery.schemas';
import {
  manualItemParamSchema,
  manualItemSchema,
  purchaseParamSchema,
  purchaseSchema,
  shoppingItemParamSchema,
  userQuantitySchema,
  type ManualItemInput,
  type PurchaseInput,
  type UserQuantityInput,
} from './shopping.schemas';
import type { ShoppingService } from './shopping.service';

type Params = { profile_id: string; grocery_list_id: string; grocery_list_item_id: string; grocery_manual_item_id: string; grocery_purchase_id: string };

function handle(status: number, fn: (auth: AuthContext, p: Params, body: unknown) => Promise<unknown>): RequestHandler {
  return async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      res.status(status).json(await fn(req.auth, req.params as unknown as Params, req.body));
    } catch (err) {
      next(err);
    }
  };
}

export function createShoppingRouter(service: ShoppingService): Router {
  const r = Router({ mergeParams: true });
  const item = '/:grocery_list_id/items/:grocery_list_item_id';
  r.get('/:grocery_list_id/shopping', validate({ params: groceryListParamSchema }), handle(200, (a, p) => service.view(a, p.profile_id, p.grocery_list_id)));
  r.post(`${item}/already-have`, validate({ params: shoppingItemParamSchema, body: userQuantitySchema }), handle(201, (a, p, b) => service.setAlreadyHave(a, p.profile_id, p.grocery_list_id, p.grocery_list_item_id, b as UserQuantityInput)));
  r.post(`${item}/already-have/clear`, validate({ params: shoppingItemParamSchema }), handle(200, (a, p) => service.clearAlreadyHave(a, p.profile_id, p.grocery_list_id, p.grocery_list_item_id)));
  r.post(`${item}/shopping-quantity`, validate({ params: shoppingItemParamSchema, body: userQuantitySchema }), handle(201, (a, p, b) => service.setAdjustment(a, p.profile_id, p.grocery_list_id, p.grocery_list_item_id, b as UserQuantityInput)));
  r.post(`${item}/shopping-quantity/clear`, validate({ params: shoppingItemParamSchema }), handle(200, (a, p) => service.clearAdjustment(a, p.profile_id, p.grocery_list_id, p.grocery_list_item_id)));
  r.post(`${item}/purchases`, validate({ params: shoppingItemParamSchema, body: purchaseSchema }), handle(201, (a, p, b) => service.addItemPurchase(a, p.profile_id, p.grocery_list_id, p.grocery_list_item_id, b as PurchaseInput)));
  r.post('/:grocery_list_id/purchases/:grocery_purchase_id/revoke', validate({ params: purchaseParamSchema }), handle(200, (a, p) => service.revokePurchase(a, p.profile_id, p.grocery_list_id, p.grocery_purchase_id)));
  r.post('/:grocery_list_id/manual-items', validate({ params: groceryListParamSchema, body: manualItemSchema }), handle(201, (a, p, b) => service.addManualItem(a, p.profile_id, p.grocery_list_id, b as ManualItemInput)));
  r.post(
    '/:grocery_list_id/manual-items/:grocery_manual_item_id/revoke',
    validate({ params: manualItemParamSchema }),
    handle(200, (a, p) => service.removeManualItem(a, p.profile_id, p.grocery_list_id, p.grocery_manual_item_id)),
  );
  r.post(
    '/:grocery_list_id/manual-items/:grocery_manual_item_id/purchases',
    validate({ params: manualItemParamSchema, body: purchaseSchema }),
    handle(201, (a, p, b) => service.addManualPurchase(a, p.profile_id, p.grocery_list_id, p.grocery_manual_item_id, b as PurchaseInput)),
  );
  return r;
}
