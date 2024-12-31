import dotenv from "dotenv";
dotenv.config();

import TelegramBot from "node-telegram-bot-api";
import { OpenAI } from "openai";
import express from "express";
import { stripeWebhookHandler } from "./stripe-webhooks";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const app = express();
const PORT = process.env.PORT || 3000;

// Load environment variables
const {
  TELEGRAM_TOKEN,
  OPENAI_API_KEY,
  WEBHOOK_URL,
  STRIPE_SECRET_KEY,
  STRIPE_ENDPOINT_SECRET,
  SUPABASE_URL,
  SUPABASE_KEY,
} = process.env;

// Initialize services
const bot = new TelegramBot(TELEGRAM_TOKEN!);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY! });
const stripe = new Stripe(STRIPE_SECRET_KEY!, {
  apiVersion: "2024-12-18.acacia",
});
const supabase = createClient(SUPABASE_URL!, SUPABASE_KEY!);

// Set webhook
bot.setWebHook(`${WEBHOOK_URL}/bot${TELEGRAM_TOKEN}`);
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      await stripeWebhookHandler(req, res, STRIPE_ENDPOINT_SECRET!);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      console.error("Error handling webhook:", errorMessage);
      res.status(400).send(`Webhook Error: ${errorMessage}`);
    }
  }
);

// Middleware
app.use(express.json());

// Webhook endpoints
app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

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
  const text = msg.text || "";
  console.log("check msg", msg);
  if (text.toLowerCase() === "/start") {
    bot.sendMessage(
      chatId,
      "Welcome! I am a Bible-based counseling bot. Ask me a question or share your concern.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  console.log(`Received message from chatId: ${chatId}, text: ${text}`);

  let { data: userPlatform, error: userPlatformError } = await supabase
    .from("user_platforms")
    .select("user_id")
    .eq("platform", "telegram")
    .eq("platform_id", chatId)
    .single();

  if (userPlatformError || !userPlatform) {
    if (userPlatformError && userPlatformError.code !== "PGRST116") {
      console.error("Error fetching user from Supabase:", userPlatformError);
      return;
    }

    const { data: newUser, error: newUserError } = await supabase
      .from("users")
      .upsert({ id: crypto.randomUUID() })
      .select();

    if (newUserError) {
      console.error("Error creating new user in Supabase:", newUserError);
      return;
    }

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

  if (user.message_count >= 10) {
    const user = await supabase
      .from("users")
      .select("email, stripe_customer_id, stripe_subscription_id")
      .eq("id", userPlatform.user_id)
      .single();

    if (user.error || !user.data) {
      console.error("Error fetching user email from Supabase:", user.error);
      return;
    }

    const createCheckoutSession = async (priceId: string) => {
      return await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: "subscription",
        success_url: `https://t.me/Scripturely_bot`,
        cancel_url: `https://muvonglao.com`,
        metadata: {
          user_id: userPlatform.user_id,
        },
      });
    };

    if (!user.data.stripe_customer_id) {
      const monthlySession = await createCheckoutSession(
        "price_1QbdT2CDSOPtkbyfxUTBULlz"
      );
      const yearlySession = await createCheckoutSession(
        "price_1QbdaPCDSOPtkbyfFQ2rsizu"
      );
      bot.sendMessage(
        chatId,
        "You have reached the free message limit. Please subscribe to continue.",
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Monthly",
                  url: monthlySession.url!,
                },
                {
                  text: "Yearly",
                  url: yearlySession.url!,
                },
              ],
            ],
          },
        }
      );
      return;
    }

    const subscription = await stripe.subscriptions.retrieve(
      user.data.stripe_subscription_id
    );

    if (subscription.status !== "active") {
      const monthlySession = await createCheckoutSession(
        "price_1QbdT2CDSOPtkbyfxUTBULlz"
      );
      const yearlySession = await createCheckoutSession(
        "price_1QbdaPCDSOPtkbyfFQ2rsizu"
      );
      bot.sendMessage(
        chatId,
        "You have reached the free message limit. Please subscribe to continue.",
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Monthly",
                  url: monthlySession.url!,
                },
                {
                  text: "Yearly",
                  url: yearlySession.url!,
                },
              ],
            ],
          },
        }
      );
      return;
    }
  }

  const placeholderMessage = await bot.sendMessage(chatId, "Typing...");

  try {
    const response = await getBiblicalCounsel(text);
    await bot.deleteMessage(chatId, placeholderMessage.message_id);
    bot.sendMessage(chatId, response, { parse_mode: "Markdown" });
  } catch (error) {
    await bot.deleteMessage(chatId, placeholderMessage.message_id);
    bot.sendMessage(
      chatId,
      "Sorry, I encountered an error. Please try again later."
    );
  }

  const { data: updatedUser, error: updateError } = await supabase
    .from("users")
    .update({ message_count: user.message_count + 1 })
    .eq("id", userPlatform.user_id);

  if (updateError) {
    console.error("Error updating message count in Supabase:", updateError);
    return;
  }

  console.log("Updated user message count in Supabase:", updatedUser);
});

// Success route

app.listen(PORT, () => {
  console.log(`Running on Port ${PORT}`);
});
