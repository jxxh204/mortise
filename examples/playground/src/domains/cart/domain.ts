import { defineDomain, provide } from '@mortise/core';
import { QuantityEditable } from '../../contracts/quantity-editable';
export default defineDomain({ provides: [provide(QuantityEditable, { scope: 'items' })] });
