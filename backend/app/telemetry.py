import streamlit as st
import fastf1
import fastf1.plotting
import pandas as pd
import plotly.graph_objects as go
import plotly.express as px
import numpy as np
import os

# --- Page Configuration ---
st.set_page_config(
    page_title="F1 Telemetry Dashboard",
    page_icon="🏎️",
    layout="wide",
    initial_sidebar_state="expanded"
)

# --- Styling & CSS ---
# This mimics the dark, sleek look of the screenshot
st.markdown("""
<style>
    .stApp {
        background-color: #111111;
        color: #ffffff;
    }
    .stSelectbox > div > div {
        background-color: #222222;
        color: white;
    }
    .metric-card {
        background-color: #1e1e1e;
        padding: 15px;
        border-radius: 10px;
        border: 1px solid #333;
        text-align: center;
    }
    h1, h2, h3 {
        color: #f0f0f0;
    }
</style>
""", unsafe_allow_html=True)

# --- Cache Setup ---
# Create a cache directory for FastF1 to store data locally
cache_dir = 'f1_cache'
if not os.path.exists(cache_dir):
    os.makedirs(cache_dir)
fastf1.Cache.enable_cache(cache_dir)

# --- Helper Functions ---

@st.cache_data
def get_schedule(year):
    try:
        schedule = fastf1.get_event_schedule(year)
        # Filter out testing sessions usually
        return schedule[schedule['EventFormat'] != 'testing']
    except Exception as e:
        return pd.DataFrame()

@st.cache_data
def load_session_data(year, event_name, session_type):
    try:
        session = fastf1.get_session(year, event_name, session_type)
        session.load()
        return session
    except Exception as e:
        return None

def get_driver_color(driver_abbr, session):
    try:
        # Try to get the official team color
        style = session.get_driver(driver_abbr)
        return f"#{style['TeamColor']}"
    except:
        return "#ffffff"  # Fallback to white

# --- Main Layout ---

st.title("🏎️ GP Tempo | F1 Telemetry Analysis")

# 1. Sidebar Controls (Dropdowns)
with st.sidebar:
    st.header("Session Settings")
    
    # Year Selection (FastF1 supports history, default to 2024 or current)
    years = list(range(2025, 2018, -1))
    selected_year = st.selectbox("Year", years, index=years.index(2024) if 2024 in years else 0)
    
    # Event Selection
    schedule = get_schedule(selected_year)
    if not schedule.empty:
        # Create a display name like "Round 1: Bahrain Grand Prix"
        schedule['DisplayName'] = schedule.apply(lambda x: f"Round {x['RoundNumber']}: {x['EventName']}", axis=1)
        # Default to the last available round or specific index
        selected_event_name = st.selectbox("Event", schedule['EventName'].tolist(), index=len(schedule)-1)
    else:
        st.error("Could not fetch schedule.")
        st.stop()

    # Session Selection
    session_types = ['FP1', 'FP2', 'FP3', 'Qualifying', 'Sprint', 'Race']
    selected_session_type = st.selectbox("Session", session_types, index=5) # Default to Race

    st.divider()
    st.info("Note: First load of a session may take a minute to download data.")

# 2. Load Data
if st.button("Load Session Data", type="primary", use_container_width=True):
    st.session_state['data_loaded'] = True
    with st.spinner(f"Loading {selected_year} {selected_event_name} - {selected_session_type}..."):
        session = load_session_data(selected_year, selected_event_name, selected_session_type)
        st.session_state['session'] = session
else:
    if 'session' not in st.session_state:
        st.session_state['data_loaded'] = False

# --- Dashboard Content ---
if st.session_state.get('data_loaded') and st.session_state.get('session'):
    session = st.session_state['session']
    
    # Get all drivers
    drivers_list = sorted(session.drivers)
    # Convert driver numbers to abbreviations for the UI
    driver_map = {d: session.get_driver(d)['Abbreviation'] for d in drivers_list}
    driver_options = [driver_map[d] for d in drivers_list]
    
    # 3. Driver Selection Area
    col_sel, col_btn = st.columns([3, 1])
    with col_sel:
        st.subheader("Select Drivers to Compare")
        # Default selection: Top 3 finishers or just some popular ones
        default_drivers = driver_options[:3] if len(driver_options) >= 3 else driver_options
        selected_drivers_abbr = st.multiselect(
            "Choose drivers:", 
            driver_options,
            default=default_drivers
        )
    
    # Map abbreviations back to driver numbers for FastF1
    selected_driver_nums = [d for d in drivers_list if driver_map[d] in selected_drivers_abbr]

    if not selected_driver_nums:
        st.warning("Please select at least one driver.")
    else:
        # --- PREPARE DATA ---
        laps = session.laps
        
        # Filter for selected drivers
        drivers_laps = laps.pick_drivers(selected_drivers_abbr)
        
        # --- TAB VIEW ---
        tab_race, tab_telem, tab_stints = st.tabs(["📊 Race Pace (Lap Times)", "📈 Telemetry Comparison", "🛞 Tire Strategies"])

        # === TAB 1: LAP TIME EVOLUTION (The Chart in your Image) ===
        with tab_race:
            st.markdown("### Lap Time Evolution")
            
            # Prepare DataFrame for Plotly
            # We filter out 'InLap' and 'OutLap' to clean the graph usually, or keep them if you want raw data
            clean_laps = drivers_laps.pick_quicklaps()  # Removes outliers/slow laps automatically
            
            fig_laps = go.Figure()

            for driver_num in selected_driver_nums:
                abbr = driver_map[driver_num]
                color = get_driver_color(abbr, session)
                
                # Get specific driver laps
                d_laps = clean_laps.pick_driver(abbr)
                
                fig_laps.add_trace(go.Scatter(
                    x=d_laps['LapNumber'],
                    y=d_laps['LapTime'].dt.total_seconds(),
                    mode='lines+markers',
                    name=abbr,
                    line=dict(color=color, width=2),
                    marker=dict(size=6)
                ))

            fig_laps.update_layout(
                template="plotly_dark",
                xaxis_title="Lap Number",
                yaxis_title="Lap Time (Seconds)",
                hovermode="x unified",
                height=500,
                legend=dict(orientation="h", y=1.02, xanchor="right", x=1),
                margin=dict(l=20, r=20, t=30, b=20),
                paper_bgcolor="#111111",
                plot_bgcolor="#111111"
            )
            
            # Inverse Y-axis because lower lap time is better? 
            # Actually standard race charts usually have faster (lower) times at the bottom.
            # But sometimes visualizers flip it. Let's keep it standard (lower value = lower on screen).
            
            st.plotly_chart(fig_laps, use_container_width=True)

            # --- LAP DATA TABLE BELOW CHART ---
            st.markdown("### Detailed Lap Data")
            # Create a pivot table for the "spreadsheet" look in the image
            # We need columns: Lap 1, Lap 2... for each driver
            pivot_data = []
            max_lap = int(drivers_laps['LapNumber'].max())
            
            for driver_num in selected_driver_nums:
                abbr = driver_map[driver_num]
                d_laps = drivers_laps.pick_driver(abbr)
                row = {'Driver': abbr}
                
                for _, lap in d_laps.iterrows():
                    lap_n = int(lap['LapNumber'])
                    # Format time as M:SS.mmm
                    ms = lap['LapTime'].total_seconds()
                    if not pd.isna(ms):
                        minutes = int(ms // 60)
                        seconds = int(ms % 60)
                        millis = int((ms * 1000) % 1000)
                        time_str = f"{minutes}:{seconds:02d}.{millis:03d}"
                        
                        # Add Tire Compound Info
                        compound = lap['Compound']
                        # Create a small emoji or code for compound
                        compound_map = {'SOFT': '🔴', 'MEDIUM': '🟡', 'HARD': '⚪', 'INTERMEDIATE': '🟢', 'WET': '🔵'}
                        c_icon = compound_map.get(compound, '')
                        
                        row[f"Lap {lap_n}"] = f"{time_str} {c_icon}"
                
                pivot_data.append(row)
            
            df_pivot = pd.DataFrame(pivot_data)
            st.dataframe(df_pivot, use_container_width=True, hide_index=True)


        # === TAB 2: TELEMETRY (Fastest Lap Comparison) ===
        with tab_telem:
            st.markdown("### Fastest Lap Telemetry Comparison")
            st.write("Comparing Speed, Throttle, and Brake traces for the fastest lap of each selected driver.")
            
            fig_telem = go.Figure()
            
            # We will use subplots: Speed (top), Throttle/Brake (bottom)
            from plotly.subplots import make_subplots
            fig_telem = make_subplots(rows=3, cols=1, shared_xaxes=True, 
                                      vertical_spacing=0.05,
                                      subplot_titles=("Speed", "Throttle", "Brake"))

            for driver_num in selected_driver_nums:
                abbr = driver_map[driver_num]
                color = get_driver_color(abbr, session)
                
                # Get fastest lap
                fastest_lap = laps.pick_driver(abbr).pick_fastest()
                try:
                    tel = fastest_lap.get_telemetry()
                    
                    # Speed
                    fig_telem.add_trace(go.Scatter(
                        x=tel['Distance'], y=tel['Speed'],
                        mode='lines', name=f"{abbr} Speed",
                        line=dict(color=color, width=2),
                        legendgroup=abbr
                    ), row=1, col=1)
                    
                    # Throttle
                    fig_telem.add_trace(go.Scatter(
                        x=tel['Distance'], y=tel['Throttle'],
                        mode='lines', name=f"{abbr} Throttle",
                        line=dict(color=color, width=2, dash='solid'),
                        legendgroup=abbr, showlegend=False
                    ), row=2, col=1)

                    # Brake
                    fig_telem.add_trace(go.Scatter(
                        x=tel['Distance'], y=tel['Brake'],
                        mode='lines', name=f"{abbr} Brake",
                        line=dict(color=color, width=2),
                        legendgroup=abbr, showlegend=False
                    ), row=3, col=1)
                    
                except:
                    st.warning(f"No telemetry data available for {abbr}")

            fig_telem.update_layout(
                height=800, 
                template="plotly_dark",
                hovermode="x unified",
                paper_bgcolor="#111111",
                plot_bgcolor="#111111"
            )
            fig_telem.update_yaxes(title_text="Speed (km/h)", row=1, col=1)
            fig_telem.update_yaxes(title_text="Throttle %", row=2, col=1)
            fig_telem.update_yaxes(title_text="Brake", row=3, col=1)
            fig_telem.update_xaxes(title_text="Distance (m)", row=3, col=1)
            
            st.plotly_chart(fig_telem, use_container_width=True)

        # === TAB 3: TIRE STINTS ===
        with tab_stints:
            st.markdown("### Tire Stint History")
            
            # Prepare Stint Data
            stint_data = []
            
            for driver_num in selected_driver_nums:
                abbr = driver_map[driver_num]
                d_laps = laps.pick_driver(abbr)
                
                # Identify stints (consecutive laps on same compound)
                # FastF1 often has a 'Stint' column, but let's recalculate to be safe or visualize usage
                stints = d_laps[['Driver', 'Stint', 'Compound', 'LapNumber']].groupby(['Driver', 'Stint', 'Compound']).agg(
                    StartLap=('LapNumber', 'min'),
                    EndLap=('LapNumber', 'max'),
                    LapsRun=('LapNumber', 'count')
                ).reset_index()
                
                for _, stint in stints.iterrows():
                    stint_data.append({
                        'Driver': abbr,
                        'Compound': stint['Compound'],
                        'Start': stint['StartLap'],
                        'Finish': stint['EndLap'],
                        'Duration': stint['LapsRun']
                    })
            
            if stint_data:
                df_stints = pd.DataFrame(stint_data)
                
                # Create Gantt Chart style
                fig_stint = px.timeline(
                    df_stints, 
                    x_start="Start", 
                    x_end="Finish", 
                    y="Driver", 
                    color="Compound",
                    color_discrete_map={
                        'SOFT': 'red', 
                        'MEDIUM': 'yellow', 
                        'HARD': 'white', 
                        'INTERMEDIATE': 'green', 
                        'WET': 'blue'
                    },
                    hover_data=['Duration']
                )
                
                # Plotly timeline uses dates by default, we need to fix x-axis to be numbers (Laps)
                # Since px.timeline is strict on dates, let's use Bar chart for better "Lap" control
                
                fig_stint_bar = go.Figure()
                
                for i, row in df_stints.iterrows():
                    color_map = {'SOFT': '#FF3333', 'MEDIUM': '#FFE700', 'HARD': '#F0F0F0', 
                                 'INTERMEDIATE': '#39D54B', 'WET': '#0078FF', 'UNKNOWN': '#555'}
                    c_color = color_map.get(row['Compound'], '#555')
                    
                    fig_stint_bar.add_trace(go.Bar(
                        y=[row['Driver']],
                        x=[row['Duration']],
                        base=[row['Start']],
                        orientation='h',
                        name=row['Compound'],
                        marker=dict(color=c_color, line=dict(width=1, color='#111')),
                        hovertemplate=f"Compound: {row['Compound']}<br>Laps: {row['Start']} - {row['Finish']}<br>Length: {row['Duration']} laps<extra></extra>",
                        showlegend=False # Hide legend to avoid duplicates, or handle manually
                    ))

                fig_stint_bar.update_layout(
                    title="Tyre Compound Usage",
                    xaxis_title="Lap Number",
                    yaxis_title="Driver",
                    template="plotly_dark",
                    barmode='stack', # This stacks them if base is correct, but we set base manually so overlay/relative works
                    height=400,
                    paper_bgcolor="#111111",
                    plot_bgcolor="#111111",
                    showlegend=False
                )
                
                # Add a manual legend
                st.markdown("""
                <div style="display: flex; gap: 20px; margin-bottom: 20px;">
                    <span style="color: #FF3333">■ Soft</span>
                    <span style="color: #FFE700">■ Medium</span>
                    <span style="color: #F0F0F0">■ Hard</span>
                    <span style="color: #39D54B">■ Inter</span>
                    <span style="color: #0078FF">■ Wet</span>
                </div>
                """, unsafe_allow_html=True)
                
                st.plotly_chart(fig_stint_bar, use_container_width=True)
            else:
                st.info("No stint data available.")

elif not st.session_state.get('data_loaded'):
    st.info("👈 Select a session from the sidebar and click 'Load Session Data' to begin.")