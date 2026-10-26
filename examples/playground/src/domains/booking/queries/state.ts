import { defineQuery } from '@mortise/core';
export default defineQuery({ async run(_, ctx) { return ctx.services.booking.get(); } });
