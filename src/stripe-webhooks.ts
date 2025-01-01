import { Request, Response } from "express";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2024-12-18.acacia",
});
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
);

export const stripeWebhookHandler = async (
  req: Request,
  res: Response,
  endpointSecret: string
) => {
  const sig = req.headers["stripe-signature"]!;
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err: any) {
    console.error(`⚠️  Webhook signature verification failed.`, err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  // Handle the event
  switch (event.type) {
    case "checkout.session.completed":
      const session = event.data.object as Stripe.Checkout.Session;
      await handleCheckoutSessionCompleted(session);
      break;
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({ received: true });
};

const handleCheckoutSessionCompleted = async (
  session: Stripe.Checkout.Session
) => {
  const userId = session.metadata?.user_id;

  const { data, error } = await supabase
    .from("users")
    .update({
      email: session.customer_details?.email,
      stripe_subscription_id: session.subscription,
      stripe_customer_id: session.customer,
    })
    .eq("id", userId);

  if (error) {
    console.error("Error saving subscription to Supabase:", error);
  }
};
