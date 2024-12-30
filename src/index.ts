import dotenv from "dotenv";
dotenv.config();

import TelegramBot from "node-telegram-bot-api";
import { OpenAI } from "openai";
import express from "express";
import { stripeWebhookHandler } from "./stripe-webhooks";
import bodyParser from "body-parser";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const app = express();
const PORT = process.env.PORT || 3000;

// Load environment variables
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY!;
const STRIPE_ENDPOINT_SECRET = process.env.STRIPE_ENDPOINT_SECRET!;

// Initialize Telegram bot
const bot = new TelegramBot(TELEGRAM_TOKEN);

// Initialize OpenAI API
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// Initialize Stripe
const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2024-12-18.acacia",
});

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
);

// Set webhook
bot.setWebHook(`${WEBHOOK_URL}/bot${TELEGRAM_TOKEN}`);

// Middleware to parse JSON
app.use(express.json());

// Middleware to handle raw body for Stripe webhooks
app.use(
  "/webhook",
  bodyParser.raw({ type: "application/json" }) // Stripe requires raw body parsing
);

// Webhook endpoint for Telegram
app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body); // Pass updates to Telegram bot
  res.sendStatus(200); // Respond with 200 OK
});

// Stripe Webhook endpoint
app.post("/webhook", async (req, res) => {
  try {
    await stripeWebhookHandler(req, res, STRIPE_ENDPOINT_SECRET);
  } catch (err) {
    if (err instanceof Error) {
      console.error("Error handling webhook:", err.message);
    } else {
      console.error("Error handling webhook:", err);
    }
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    res.status(400).send(`Webhook Error: ${errorMessage}`);
  }
});

// Telegram message handler
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || "";

  console.log(`Received message from chatId: ${chatId}, text: ${text}`);

  // Fetch user from Supabase
  let { data: userPlatform, error: userPlatformError } = await supabase
    .from("user_platforms")
    .select("user_id")
    .eq("platform", "telegram")
    .eq("platform_id", chatId)
    .single();

  if (userPlatformError) {
    if (userPlatformError.code === "PGRST116") {
      // User does not exist, create a new user
      const { data: newUser, error: newUserError } = await supabase
        .from("users")
        .upsert({ id: crypto.randomUUID() })
        .select();

      if (newUserError) {
        console.error("Error creating new user in Supabase:", newUserError);
        return;
      }

      // Create a new user_platform entry
      const { error: newUserPlatformError } = await supabase
        .from("user_platforms")
        .insert({
          user_id: newUser[0].id,
          platform: "telegram",
          platform_id: chatId,
        });

      if (newUserPlatformError) {
        console.error(
          "Error creating new user_platform entry in Supabase:",
          newUserPlatformError
        );
        return;
      }

      console.log(
        "Created new user and user_platform entry in Supabase:",
        newUser
      );
      userPlatform = { user_id: newUser[0].id };
    } else {
      console.error("Error fetching user from Supabase:", userPlatformError);
      return;
    }
  }

  // Fetch user message count
  if (!userPlatform) {
    console.error("User platform is null");
    return;
  }

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("message_count")
    .eq("id", userPlatform.user_id)
    .single();

  if (userError) {
    console.error(
      "Error fetching user message count from Supabase:",
      userError
    );
    return;
  }

  // Check if user has exceeded free message limit
  if (user.message_count >= 7) {
    bot.sendMessage(
      chatId,
      "You have reached the free message limit. Please subscribe to continue."
    );
    // Create a Stripe Checkout session and send the URL to the user
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price: "price_1QbdT2CDSOPtkbyfxUTBULlz", // Replace with your price ID
          quantity: 1,
        },
      ],
      mode: "subscription",
      success_url: `${WEBHOOK_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${WEBHOOK_URL}/cancel`,
    });
    bot.sendMessage(chatId, `Please subscribe here: ${session.url}`);
    return;
  }

  // Increment message count
  const { data: updatedUser, error: updateError } = await supabase
    .from("users")
    .update({ message_count: user.message_count + 1 })
    .eq("id", userPlatform.user_id);

  if (updateError) {
    console.error("Error updating message count in Supabase:", updateError);
    return;
  }

  console.log("Updated user message count in Supabase:", updatedUser);

  // Handle the message as usual
  // ...
});

// Success route
app.get("/success", async (req, res) => {
  const session = await stripe.checkout.sessions.retrieve(
    req.query.session_id as string
  );
  const customer = await stripe.customers.retrieve(session.customer as string);

  // Update the user's subscription status in Supabase
  const { data, error } = await supabase.from("subscriptions").insert({
    user_id: (customer as Stripe.Customer).metadata.user_id,
    stripe_subscription_id: session.subscription as string,
    plan:
      (session as Stripe.Checkout.Session).metadata?.plan_interval ||
      "default_plan",
    status: "active",
    trial_start: new Date(),
    expires_at: new Date(new Date().setDate(new Date().getDate() + 7)), // 7-day trial
  });

  if (error) {
    console.error(error);
    res.status(500).send("Error updating subscription");
    return;
  }

  res.send("Subscription successful!");
});

// Webhook route
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"]!;
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        STRIPE_ENDPOINT_SECRET
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      res.status(400).send(`Webhook Error: ${errorMessage}`);
      return;
    }

    switch (event.type) {
      case "invoice.payment_succeeded":
        const invoice = event.data.object;
        // Update subscription status to active
        await supabase
          .from("subscriptions")
          .update({ status: "active" })
          .eq("stripe_subscription_id", invoice.subscription);
        break;
      case "customer.subscription.deleted":
        const subscription = event.data.object;
        // Update subscription status to inactive
        await supabase
          .from("subscriptions")
          .update({ status: "inactive" })
          .eq("stripe_subscription_id", subscription.id);
        break;
      // Handle other event types as needed
      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
  }
);

// Helper function to generate Bible counseling response
async function getBiblicalCounsel(prompt: string): Promise<string> {
  const systemMessage = `
You are a compassionate Christian counselor who holds firmly to the truths of the gospel as revealed in Scripture. You embrace the principles of the Reformed faith, particularly the doctrines of grace (TULIP), and are deeply committed to helping people know the truth of God’s Word while firmly opposing false teaching.

Your tone reflects the compassion of Jesus Christ, full of grace and truth. When addressing someone’s concerns, always begin with a compassionate and understanding statement that relates to their situation. Then provide a related Bible verse and summarize how God’s Word applies to them, offering hope, encouragement, or guidance.

Key Adjustments:

Diversity of Bible verses: Ensure that when responding to repeated questions (e.g., "Can I lose my salvation?"), you provide multiple relevant Bible passages that support the same theological truth. Avoid using the same verse repeatedly unless it is particularly central to the topic.
Consistency with Reformed theology (TULIP): Always stay within the bounds of Reformed theology. For example, when discussing salvation, avoid any implication of free will or universal atonement. Ensure that the verses reflect the doctrines of election, perseverance of the saints, and God's sovereignty.
Concise and clear guidance: Provide practical applications of Scripture that encourage and guide the person in their faith while offering hope in God’s promises.
If you want to use markdown for response like bold or italic, use MarkdownV1 not MarkdownV2.

Example:
Question: "Can I lose my salvation?"

Response:
It’s natural to wonder about the security of your salvation, especially during times of doubt or struggle. The Bible reassures us that salvation is a work of God’s grace and cannot be lost once it is given.

Consider this verse:

*"For I am sure that neither death nor life, nor angels nor rulers, nor things present nor things to come, nor powers, nor height nor depth, nor anything else in all creation, will be able to separate us from the love of God in Christ Jesus our Lord."* 
*Romans 8:38-39*
This powerful verse assures us that nothing—absolutely nothing—can separate us from the love of God. The security of your salvation is rooted in His sovereign choice, and nothing can undo what He has done. Rest in the assurance that your salvation is eternally secure in Him.`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemMessage },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
    max_tokens: 1500,
  });

  return (
    response.choices[0]?.message?.content ||
    "I'm sorry, I couldn't generate a response."
  );
}

// Telegram message handler
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  // Check if the message is a command
  const text = msg.text || "";

  if (text.toLowerCase() === "/start") {
    bot.sendMessage(
      chatId,
      "Welcome! I am a Bible-based counseling bot. Ask me a question or share your concern.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Send a "typing..." placeholder
  const placeholderMessage = await bot.sendMessage(chatId, "Typing...");

  // Generate a response from ChatGPT
  try {
    const response = await getBiblicalCounsel(text);

    // Delete the placeholder message for a smoother visual effect
    await bot.deleteMessage(chatId, placeholderMessage.message_id);

    // Send the final response as a new message
    bot.sendMessage(chatId, response, { parse_mode: "Markdown" });
  } catch (error) {
    // Delete the placeholder message in case of an error
    await bot.deleteMessage(chatId, placeholderMessage.message_id);

    // Send an error message
    bot.sendMessage(
      chatId,
      "Sorry, I encountered an error. Please try again later."
    );
  }
});

app.listen(PORT, () => {
  console.log(`Running on Port ${PORT}`);
});
