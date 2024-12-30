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
      // Save subscription details to Supabase
      await handleCheckoutSessionCompleted(session);
      break;
    case "invoice.payment_succeeded":
      const invoice = event.data.object as Stripe.Invoice;
      // Update subscription status to active
      await handleInvoicePaymentSucceeded(invoice);
      break;
    case "customer.subscription.deleted":
      const subscription = event.data.object as Stripe.Subscription;
      // Update subscription status to inactive
      await handleSubscriptionDeleted(subscription);
      break;
    // Add more event types as needed
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({ received: true });
};

const handleCheckoutSessionCompleted = async (
  session: Stripe.Checkout.Session
) => {
  const customer = await stripe.customers.retrieve(session.customer as string);
  if ("deleted" in customer && customer.deleted) {
    console.error("Customer has been deleted");
    return;
  }
  const userId = (customer as Stripe.Customer).metadata.user_id;

  const { data, error } = await supabase.from("subscriptions").insert({
    user_id: userId,
    stripe_subscription_id: session.subscription,
    plan: session.subscription,
    status: "active",
    trial_start: new Date(),
    expires_at: new Date(new Date().setDate(new Date().getDate() + 7)), // 7-day trial
  });

  if (error) {
    console.error("Error saving subscription to Supabase:", error);
  }
};

const handleInvoicePaymentSucceeded = async (invoice: Stripe.Invoice) => {
  const subscriptionId = invoice.subscription as string;

  const { data, error } = await supabase
    .from("subscriptions")
    .update({ status: "active" })
    .eq("stripe_subscription_id", subscriptionId);

  if (error) {
    console.error("Error updating subscription status in Supabase:", error);
  }
};

const handleSubscriptionDeleted = async (subscription: Stripe.Subscription) => {
  const subscriptionId = subscription.id;

  const { data, error } = await supabase
    .from("subscriptions")
    .update({ status: "inactive" })
    .eq("stripe_subscription_id", subscriptionId);

  if (error) {
    console.error("Error updating subscription status in Supabase:", error);
  }
};
