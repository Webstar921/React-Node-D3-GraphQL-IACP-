// -*- mode: react; -*-
import {
  GraphQLObjectType as ObjectType,
  GraphQLNonNull as NonNull,
  GraphQLString as StringType,
  GraphQLInt as IntType,
  GraphQLBoolean as BooleanType,
} from 'graphql';

import Stripe from 'stripe';
import logger from '../../core/logger.js';
import { STRIPESECKEY } from '../../secrets';
import sendDonationEmail from '../../email/Donation';
import { User, Donation } from '../models';
import ErrorType from '../types/ErrorType';
import { DONATE_COMPLETED, DONATE_CANCELED } from '../../constants/donate';

const stripe = Stripe(STRIPESECKEY);

const donate = {
  type: new ObjectType({
    name: 'donateResult',
    fields: {
      errors: {
        type: ErrorType,
      },
    },
  }),
  args: {
    token: { type: new NonNull(StringType) },
    email: { type: new NonNull(StringType) },
    fullName: { type: new NonNull(StringType) },
    zipCode: { type: new NonNull(StringType) },
    amount: { type: new NonNull(IntType) },
    announceAmount: { type: new NonNull(BooleanType) },
    announceName: { type: new NonNull(BooleanType) },
  },
  async resolve(root, { token, email, fullName, zipCode, amount, announceAmount, announceName }) {
    try {
      const donation = await Donation.create({
        amount,
        token,
        email,
        fullName,
        zipCode,
        announceAmount,
        announceName,
      });

      const description = `One time donation from ${fullName} <${email}> to IA-CP Organization.`;
      const stripeAmount = parseInt(amount, 10) * 100;

      const errors = [];

      // check to see if there's already a user with that email
      const emailLc = email.toLowerCase();
      const user = await User.findOne({ where: { email: emailLc } });

      if (user) {
        donation.userId = user.id;
        await donation.save();
      }

      if (errors.length === 0) {
        try {
          const charge = await stripe.charges.create({
            amount: stripeAmount,
            currency: 'usd',
            source: token, // obtained with Stripe.js
            description,
          });
          if (charge.paid) {
            donation.status = DONATE_COMPLETED;
          } else {
            donation.status = DONATE_CANCELED;
          }
          if (charge.source) {
            donation.exp_month = charge.source.exp_month;
            donation.exp_year = charge.source.exp_year;
            donation.last4 = charge.source.last4;
            donation.country = charge.source.country;
            donation.brand = charge.source.brand;
          }
          await donation.save();
        } catch (e) {
          errors.push({ key: 'stripe', message: e.message });
        }
      }

      if (errors.length > 0) {
        logger.error('Donation failed', { email, fullName, amount, zipCode, token, errors });
        donation.status = DONATE_CANCELED;
        await donation.save();
      } else {
        logger.info('Donation Succeed', { email, fullName, amount, zipCode, token });
        await sendDonationEmail(email, amount);
        logger.info('Donation email has been sent', { email, fullName, amount, zipCode, token });
      }

      return {
        errors,
      };
    } catch (e) {
      logger.error('Donation failed', { email, fullName, amount, zipCode, token, e });
      // should we return e.message? these are errors from stripe, Donation creation in db, etc.
      const errors = [
        {
          key: 'general',
          message: 'Unexpected server error',
        },
      ];
      return {
        errors,
      };
    }
  },
};

export default { donate };
