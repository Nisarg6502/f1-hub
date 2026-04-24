from datetime import datetime


def get_reminder_mail_template(
    timing: str,
    grand_prix_name: str,
    grand_prix_country: str,
    session_type: str,
    session_duration: int,
    session_datetime: datetime
) -> str:
    """
    Generate HTML email template for F1 session reminders.
    
    Args:
        timing: Reminder timing (e.g., "24 Hour", "1 Hour", "15 Minute")
        grand_prix_name: Name of the Grand Prix
        grand_prix_country: Country where the Grand Prix is held
        session_type: Type of session (e.g., "Practice 1", "Qualifying", "Race")
        session_duration: Duration of the session in minutes
        session_datetime: Datetime object for the session start time (should be in IST)
    
    Returns:
        Formatted HTML string for the email
    """
    # Format timing text
    timing_upper = timing.upper()
    timing_lower = timing.lower()
    
    # Determine timing text for the alert message
    if timing == "24 Hour":
        timing_text = "24 hours"
    elif timing == "1 Hour":
        timing_text = "1 hour"
    else:
        timing_text = "15 minutes"
    
    # Format date and time (IST format)
    formatted_date = session_datetime.strftime("%A, %B %d, %Y")
    formatted_time = session_datetime.strftime("%I:%M %p")
    
    return f"""
<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>F1 {timing} Reminder - {grand_prix_name}</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #303030; min-height: 100vh;">
      
      <!-- Main Container -->
      <div style="max-width: 650px; margin: 0 auto; background: #ffffff; box-shadow: 0 20px 60px rgba(0,0,0,0.3);">
        
        <!-- Header with F1 Branding -->
        <div style="background: #e10600; padding: 0;">
          
          <!-- Racing stripes effect using borders -->
          <div style="height: 8px; background: #ffffff; opacity: 0.3;"></div>
          
          <!-- Main header content -->
          <div style="padding: 30px 40px; text-align: center;">
            <img src="cid:f1logo_white" alt="Formula 1 Logo" style="height: 50px; margin-bottom: 15px;">
            
            <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px;">
              {grand_prix_name}
            </h1>
            
            <div style="margin-top: 15px; padding: 8px 20px; background: #000000; color: #e10600; border-radius: 25px; display: inline-block;">
              <span style="font-size: 16px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">
                {timing_upper} REMINDER
              </span>
            </div>
          </div>
          
          <!-- Bottom racing stripe -->
          <div style="height: 6px; background: #ffffff;"></div>
        </div>
        
        <!-- Main Content -->
        <div style="padding: 40px;">
          
          <!-- Session Alert Message -->
          <div style="text-align: center; margin-bottom: 35px;">
            <h2 style="margin: 0 0 15px 0; color: #1a1a1a; font-size: 24px; font-weight: 600;">
              {session_type} Starting Soon! 
            </h2>
            <p style="margin: 0; color: #666; font-size: 16px; line-height: 1.6;">
              The <strong style="color: #e10600;">{session_type}</strong> at {grand_prix_name} is about to begin. Don't miss the action!
            </p>
          </div>
          
          <!-- Session Details Highlight Box -->
          <div style="background: #f8f9fa; border-left: 5px solid #e10600; border-top: 2px solid #ffebeb; border-right: 1px solid #f1f1f1; border-bottom: 1px solid #f1f1f1; padding: 25px; margin-bottom: 30px; border-radius: 8px; box-shadow: 0 2px 8px rgba(225,6,0,0.08);">
            <!-- Top accent bar for visual interest -->
            <div style="position: absolute; top: 0; right: 0; width: 60px; height: 3px; background: #e10600; opacity: 0.3;"></div>
            
            <h3 style="margin: 0 0 10px 0; color: #e10600; font-size: 20px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;">
              RACE WEEKEND ALERT
            </h3>
            <p style="margin: 0; color: #495057; font-size: 15px; line-height: 1.5;">
              <strong>{session_type}</strong> session at <strong>{grand_prix_country}</strong> begins in <strong>{timing_text}</strong>. Get your screens ready for the ultimate F1® experience.
            </p>
          </div>
          
          <!-- Session Information Grid -->
          <div style="margin-bottom: 35px;">
            <h3 style="margin: 0 0 25px 0; color: #1a1a1a; font-size: 20px; font-weight: 600; text-align: center;">
              Session Details
            </h3>
            
            <!-- Session details in 2x2 grid -->
            <div style="display: table; width: 100%; border-spacing: 15px;">
              
              <!-- Row 1 -->
              <div style="display: table-row;">
                <div style="display: table-cell; width: 50%; background: #fff; border: 2px solid #f1f3f4; border-radius: 12px; padding: 20px; vertical-align: top; transition: all 0.3s ease;">
                  <h4 style="margin: 0 0 8px 0; color: #1a1a1a; font-size: 16px; font-weight: 600; text-align: center;">Date</h4>
                  <p style="margin: 0; color: #6c757d; font-size: 14px; line-height: 1.4; text-align: center;">
                    {formatted_date}
                  </p>
                </div>
                
                <div style="display: table-cell; width: 50%; background: #fff; border: 2px solid #f1f3f4; border-radius: 12px; padding: 20px; vertical-align: top;">
                  <h4 style="margin: 0 0 8px 0; color: #1a1a1a; font-size: 16px; font-weight: 600; text-align: center;">Time (IST)</h4>
                  <p style="margin: 0; color: #6c757d; font-size: 14px; line-height: 1.4; text-align: center;">
                    {formatted_time}
                  </p>
                </div>
              </div>
              
              <!-- Row 2 -->
              <div style="display: table-row;">
                <div style="display: table-cell; background: #fff; border: 2px solid #f1f3f4; border-radius: 12px; padding: 20px; vertical-align: top;">
                  <h4 style="margin: 0 0 8px 0; color: #1a1a1a; font-size: 16px; font-weight: 600; text-align: center;">Location</h4>
                  <p style="margin: 0; color: #6c757d; font-size: 14px; line-height: 1.4; text-align: center;">{grand_prix_country}</p>
                </div>
                
                <div style="display: table-cell; background: #fff; border: 2px solid #f1f3f4; border-radius: 12px; padding: 20px; vertical-align: top;">
                  <h4 style="margin: 0 0 8px 0; color: #1a1a1a; font-size: 16px; font-weight: 600; text-align: center;">Duration</h4>
                  <p style="margin: 0; color: #6c757d; font-size: 14px; line-height: 1.4; text-align: center;">{session_duration} minutes</p>
                </div>
              </div>
            </div>
          </div>
          
          <!-- Call to Action -->
          <div style="text-align: center; padding: 25px; background: linear-gradient(45deg, #e8f9fa, #ffffff); border-radius: 12px; border: 1px solid #e9ecef; margin-bottom: 30px;">
            <h3 style="margin: 0 0 15px 0; color: #1a1a1a; font-size: 18px; font-weight: 600;">
              Don't Miss the Action!
            </h3>
            <p style="margin: 0 0 20px 0; color: #6c757d; font-size: 15px; line-height: 1.5;">
              Access live timing, track the race, and get real-time updates. Your premium F1® experience awaits.
            </p>
            <div style="margin-bottom: 15px;">
              <a href="https://www.formula1.com/en/racing/2025.html" style="display: inline-block; background: #e10600; color: #ffffff; padding: 12px 25px; border-radius: 25px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; font-size: 14px; text-decoration: none; margin: 0 10px 10px 0;">
                LIVE TIMING
              </a>
              <a href="https://www.formula1.com/en/latest.html" style="display: inline-block; background: transparent; border: 2px solid #e10600; color: #e10600; padding: 10px 23px; border-radius: 25px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; font-size: 14px; text-decoration: none; margin: 0 10px 10px 0;">
                F1 APP
              </a>
            </div>
          </div>
          
          <!-- Support & Contact -->
          <div style="text-align: center; padding: 20px 0; border-top: 1px solid #e9ecef;">
            <p style="margin: 0 0 10px 0; color: #6c757d; font-size: 14px;">
              Enjoying your F1® notifications? Managing your preferences is easy.
            </p>
            <p style="margin: 0; color: #e10600; font-size: 14px; font-weight: 600;">
              Premium Support • Always Here to Help
            </p>
          </div>
        </div>
        
        <!-- Footer -->
        <div style="background: #1a1a1a; color: #ffffff; padding: 25px 40px; text-align: center;">
          <div style="margin-bottom: 15px;">
            <img src="cid:f1logo" alt="Formula 1" style="height: 50px; opacity: 0.8;">
          </div>
          
          <p style="margin: 0 0 10px 0; font-size: 13px; color: #cccccc; line-height: 1.4;">
            This is your {timing_lower} reminder from the F1® Notification System.
          </p>
          
          <p style="margin: 0; font-size: 12px; color: #999999;">
            © 2025 Formula 1® World Championship Limited. All rights reserved.<br>
            Formula 1®, F1®, and related marks are trademarks of Formula One Licensing BV.
          </p>
          
          <!-- Social Links Placeholder -->
          <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #333333;">
            <span style="color: #666666; font-size: 11px; text-transform: uppercase; letter-spacing: 1px;">
              Follow F1® • Official Championship Coverage
            </span>
          </div>
        </div>
      </div>
      
      <!-- Ambient spacing -->
      <div style="height: 40px;"></div>
    </body>
    </html>
"""